import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { pool } from "../db/index.js";
import type { Role } from "../auth/provider.js";
import { getRequestContext } from "../requestContext.js";
import { computeChainHash, stableStringify } from "../utils/hashChain.js";

export interface AuditEntry {
  audit_id: string;
  scenario_id: string;
  action_type: string;
  user_id: string;
  action_details: Record<string, unknown> | null;
  touched_levers_snapshot?: Record<string, unknown>[] | null;
  timestamp: string;
  prev_hash?: string | null;
  row_hash?: string | null;
  request_id?: string | null;
  ip_address?: string | null;
  user_agent?: string | null;
}

/** Optional request metadata for audit rows (also pulled from AsyncLocalStorage). */
export interface AuditMeta {
  requestId?: string;
  ip?: string;
  userAgent?: string;
}

export interface AuditChainVerifyResult {
  valid: boolean;
  checked: number;
  firstBadId?: string;
  reason?: string;
}

/** Canonical payload hashed into the chain (order-stable, no whitespace variance). */
export function canonicalAuditPayload(fields: {
  audit_id: string;
  scenario_id: string;
  action_type: string;
  user_id: string;
  action_details: unknown;
  touched_levers_snapshot: unknown;
  timestamp: string;
  request_id: string | null;
  ip_address: string | null;
  user_agent: string | null;
}): string {
  return stableStringify({
    action_details: fields.action_details ?? null,
    action_type: fields.action_type,
    audit_id: fields.audit_id,
    ip_address: fields.ip_address,
    request_id: fields.request_id,
    scenario_id: fields.scenario_id,
    timestamp: fields.timestamp,
    touched_levers_snapshot: fields.touched_levers_snapshot ?? null,
    user_agent: fields.user_agent,
    user_id: fields.user_id,
  });
}

export function computeRowHash(prevHash: string, canonicalPayload: string): string {
  return computeChainHash(prevHash, canonicalPayload);
}

export async function logAudit(
  scenarioId: string,
  actionType: string,
  details?: Record<string, unknown>,
  userId?: string,
  touchedLeversSnapshot?: Record<string, unknown>[],
  meta?: AuditMeta,
  client?: PoolClient,
): Promise<void> {
  if (!userId) {
    throw new Error("logAudit requires userId");
  }

  const ctx = getRequestContext();
  const requestId = meta?.requestId ?? ctx?.requestId ?? null;
  const ip = meta?.ip ?? ctx?.ip ?? null;
  const userAgent = meta?.userAgent ?? ctx?.userAgent ?? null;

  const auditId = randomUUID();
  // ISO string is also what verifyAuditChain reconstructs via to_char(..., ...Z).
  const timestamp = new Date().toISOString();
  const actionDetailsJson = details ? JSON.stringify(details) : null;
  const touchedJson = touchedLeversSnapshot ? JSON.stringify(touchedLeversSnapshot) : null;

  const ownsTxn = !client;
  const db = client ?? (await pool.connect());
  try {
    if (ownsTxn) await db.query("BEGIN");

    // Ensure singleton head row exists, then lock it for the chain append.
    await db.query(
      `INSERT INTO audit_chain_head (id, last_hash, last_audit_id)
       VALUES (1, NULL, NULL)
       ON CONFLICT (id) DO NOTHING`,
    );
    const headRes = await db.query<{ last_hash: string | null }>(
      `SELECT last_hash FROM audit_chain_head WHERE id = 1 FOR UPDATE`,
    );
    const prevHash = headRes.rows[0]?.last_hash ?? "";

    const canonical = canonicalAuditPayload({
      audit_id: auditId,
      scenario_id: scenarioId,
      action_type: actionType,
      user_id: userId,
      // Round-trip through JSON so hash matches JSONB on verify.
      action_details: details ? JSON.parse(JSON.stringify(details)) : null,
      touched_levers_snapshot: touchedLeversSnapshot
        ? JSON.parse(JSON.stringify(touchedLeversSnapshot))
        : null,
      timestamp,
      request_id: requestId,
      ip_address: ip,
      user_agent: userAgent,
    });
    const rowHash = computeRowHash(prevHash, canonical);

    await db.query(
      `INSERT INTO audit_trail (
         audit_id, scenario_id, action_type, user_id, action_details,
         touched_levers_snapshot, timestamp, prev_hash, row_hash,
         request_id, ip_address, user_agent
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        auditId,
        scenarioId,
        actionType,
        userId,
        actionDetailsJson,
        touchedJson,
        timestamp,
        prevHash,
        rowHash,
        requestId,
        ip,
        userAgent,
      ],
    );

    await db.query(
      `UPDATE audit_chain_head SET last_hash = $1, last_audit_id = $2 WHERE id = 1`,
      [rowHash, auditId],
    );

    if (ownsTxn) await db.query("COMMIT");
  } catch (e) {
    if (ownsTxn) await db.query("ROLLBACK");
    throw e;
  } finally {
    if (ownsTxn) db.release();
  }
}

/**
 * Walk the audit chain in chronological order and verify each row_hash.
 * Leading rows without row_hash (pre-migration) are skipped as a legacy
 * prefix; the first hashed row must start from genesis (prev_hash "").
 */
export async function verifyAuditChain(): Promise<AuditChainVerifyResult> {
  const res = await pool.query<{
    audit_id: string;
    scenario_id: string;
    action_type: string;
    user_id: string;
    action_details: unknown;
    touched_levers_snapshot: unknown;
    timestamp: Date | string;
    prev_hash: string | null;
    row_hash: string | null;
    request_id: string | null;
    ip_address: string | null;
    user_agent: string | null;
  }>(
    `SELECT audit_id, scenario_id, action_type, user_id, action_details,
            touched_levers_snapshot, timestamp,
            prev_hash, row_hash,
            request_id, ip_address::text AS ip_address, user_agent
     FROM audit_trail
     ORDER BY timestamp ASC, audit_id ASC`,
  );

  /** null = still consuming unhashed legacy prefix */
  let expectedPrev: string | null = null;
  let checked = 0;
  let legacySkipped = 0;

  for (const row of res.rows) {
    if (!row.row_hash) {
      if (expectedPrev !== null) {
        return {
          valid: false,
          checked,
          firstBadId: row.audit_id,
          reason: "unhashed row after hash-chained rows",
        };
      }
      legacySkipped++;
      continue;
    }

    checked++;
    if (expectedPrev === null) {
      expectedPrev = "";
    }

    const prev = row.prev_hash ?? "";
    if (prev !== expectedPrev) {
      return {
        valid: false,
        checked,
        firstBadId: row.audit_id,
        reason: `prev_hash mismatch: expected ${expectedPrev || "(genesis)"}, got ${prev || "(empty)"}`,
      };
    }

    const ts =
      row.timestamp instanceof Date
        ? row.timestamp.toISOString()
        : new Date(row.timestamp).toISOString();
    const canonical = canonicalAuditPayload({
      audit_id: row.audit_id,
      scenario_id: row.scenario_id,
      action_type: row.action_type,
      user_id: row.user_id,
      action_details: row.action_details,
      touched_levers_snapshot: row.touched_levers_snapshot,
      timestamp: ts,
      request_id: row.request_id,
      ip_address: row.ip_address,
      user_agent: row.user_agent,
    });
    const expectedHash = computeRowHash(prev, canonical);
    if (expectedHash !== row.row_hash) {
      return {
        valid: false,
        checked,
        firstBadId: row.audit_id,
        reason: "row_hash does not match canonical payload",
      };
    }
    expectedPrev = row.row_hash;
  }

  return {
    valid: true,
    checked,
    ...(legacySkipped > 0
      ? { reason: `ok; skipped ${legacySkipped} pre-chain legacy row(s)` }
      : {}),
  };
}

export async function getAuditTrail(
  filters: { scenario_id?: string; action_type?: string; limit?: number; offset?: number; userId?: string; role?: Role }
): Promise<{ entries: AuditEntry[]; total: number }> {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;
  const from = `FROM audit_trail a
    JOIN scenarios s ON s.scenario_id = a.scenario_id`;
  if (filters.scenario_id) {
    conditions.push(`a.scenario_id = $${idx++}`);
    values.push(filters.scenario_id);
  }
  if (filters.action_type) {
    conditions.push(`a.action_type = $${idx++}`);
    values.push(filters.action_type);
  }
  if (filters.userId && filters.role !== "admin") {
    conditions.push(`(s.creator_id = $${idx} OR EXISTS (
      SELECT 1 FROM scenario_sharing ss
      WHERE ss.scenario_id = s.scenario_id AND ss.shared_with = $${idx}
    ))`);
    values.push(filters.userId);
    idx++;
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = Math.min(filters.limit || 100, 500);
  const offset = filters.offset || 0;

  const countRes = await pool.query(`SELECT COUNT(*) ${from} ${where}`, values);
  const total = parseInt(countRes.rows[0].count, 10);

  try {
    const dataRes = await pool.query(
      `SELECT a.audit_id, a.scenario_id, a.action_type, a.user_id, a.action_details, a.touched_levers_snapshot, a.timestamp
       ${from} ${where} ORDER BY a.timestamp DESC LIMIT $${idx++} OFFSET $${idx}`,
      [...values, limit, offset]
    );
    return { entries: dataRes.rows, total };
  } catch (e) {
    const err = e as { code?: string };
    if (err.code !== "42703") throw e;
    const dataRes = await pool.query(
      `SELECT a.audit_id, a.scenario_id, a.action_type, a.user_id, a.action_details, NULL::jsonb as touched_levers_snapshot, a.timestamp
       ${from} ${where} ORDER BY a.timestamp DESC LIMIT $${idx++} OFFSET $${idx}`,
      [...values, limit, offset]
    );
    return { entries: dataRes.rows, total };
  }
}

const EXPORT_PAGE_SIZE = 500;

/** Fetches every matching audit row (paginated internally) — exports must never silently truncate. */
async function getFullAuditTrail(opts: {
  scenarioId?: string;
  userId: string;
  role: Role;
}): Promise<AuditEntry[]> {
  const all: AuditEntry[] = [];
  let offset = 0;
  for (;;) {
    const { entries, total } = await getAuditTrail({
      scenario_id: opts.scenarioId,
      limit: EXPORT_PAGE_SIZE,
      offset,
      userId: opts.userId,
      role: opts.role,
    });
    all.push(...entries);
    offset += entries.length;
    if (entries.length === 0 || offset >= total) break;
  }
  return all;
}

export async function exportAuditCsv(opts: {
  scenarioId?: string;
  userId: string;
  role: Role;
}): Promise<string> {
  const entries = await getFullAuditTrail(opts);
  const lines = ["audit_id,scenario_id,action_type,user_id,timestamp,details,touched_levers_snapshot"];
  for (const e of entries) {
    const details = e.action_details ? JSON.stringify(e.action_details).replace(/"/g, '""') : "";
    const touched = e.touched_levers_snapshot ? JSON.stringify(e.touched_levers_snapshot).replace(/"/g, '""') : "";
    lines.push(`"${e.audit_id}","${e.scenario_id}","${e.action_type}","${e.user_id}","${e.timestamp}","${details}","${touched}"`);
  }
  return lines.join("\n");
}

export async function exportAuditJson(opts: {
  scenarioId?: string;
  userId: string;
  role: Role;
}): Promise<AuditEntry[]> {
  return getFullAuditTrail(opts);
}
