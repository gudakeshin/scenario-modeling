import { pool } from "../db/index.js";
import { computeChainHash, stableStringify } from "../utils/hashChain.js";

const GENESIS_HASH = "0".repeat(64);

export interface UpsIWorkspacePolicy {
  workspace_id: string;
  sensitivity: "public" | "confidential" | "upsi";
  nature_of_upsi: string | null;
}

export async function getUpsIWorkspacePolicy(
  workspaceId: string,
): Promise<UpsIWorkspacePolicy | null> {
  const result = await pool.query<UpsIWorkspacePolicy>(
    `SELECT workspace_id, sensitivity, nature_of_upsi
     FROM workspaces WHERE workspace_id = $1 AND status = 'active'`,
    [workspaceId],
  );
  return result.rows[0] ?? null;
}

/** UPSI workspaces have no admin/role bypass: access must be explicitly granted. */
export async function assertUpsIWorkspaceMembership(
  userId: string,
  workspaceId: string | null,
): Promise<UpsIWorkspacePolicy | null> {
  if (!workspaceId) return null;
  const policy = await getUpsIWorkspacePolicy(workspaceId);
  if (!policy || policy.sensitivity !== "upsi") return policy;
  const membership = await pool.query(
    `SELECT 1 FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2`,
    [workspaceId, userId],
  );
  if (!membership.rows[0]) {
    throw Object.assign(new Error("UPSI workspace access requires explicit need-to-know membership"), {
      status: 403,
      code: "UPSI_MEMBERSHIP_REQUIRED",
    });
  }
  return policy;
}

export async function logUpsIAccess(input: {
  workspaceId: string;
  userId: string;
  artifactType: string;
  artifactId: string;
  action?: string;
  natureOfUpsi?: string | null;
}): Promise<string | null> {
  const policy = await assertUpsIWorkspaceMembership(input.userId, input.workspaceId);
  if (!policy || policy.sensitivity !== "upsi") return null;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO upsi_access_chain_head (workspace_id, head_hash)
       VALUES ($1, $2) ON CONFLICT (workspace_id) DO NOTHING`,
      [input.workspaceId, GENESIS_HASH],
    );
    const head = await client.query<{ head_hash: string }>(
      `SELECT head_hash FROM upsi_access_chain_head WHERE workspace_id = $1 FOR UPDATE`,
      [input.workspaceId],
    );
    const timestamp = await client.query<{ now: Date }>("SELECT NOW() AS now");
    const accessedAt = timestamp.rows[0].now.toISOString();
    const nature =
      input.natureOfUpsi ||
      policy.nature_of_upsi ||
      "Unpublished price-sensitive financial information";
    const payload = {
      workspace_id: input.workspaceId,
      user_id: input.userId,
      artifact_type: input.artifactType,
      artifact_id: input.artifactId,
      action: input.action ?? "read",
      nature_of_upsi: nature,
      accessed_at: accessedAt,
    };
    const prevHash = head.rows[0]?.head_hash ?? GENESIS_HASH;
    const rowHash = computeChainHash(prevHash, stableStringify(payload));
    await client.query(
      `INSERT INTO upsi_access_log (
         workspace_id, user_id, artifact_type, artifact_id, action,
         nature_of_upsi, accessed_at, prev_hash, row_hash
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        input.workspaceId,
        input.userId,
        payload.artifact_type,
        payload.artifact_id,
        payload.action,
        nature,
        accessedAt,
        prevHash,
        rowHash,
      ],
    );
    await client.query(
      `UPDATE upsi_access_chain_head SET head_hash = $2, updated_at = NOW()
       WHERE workspace_id = $1`,
      [input.workspaceId, rowHash],
    );
    await client.query("COMMIT");
    return rowHash;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listUpsIAccessLog(workspaceId: string) {
  const result = await pool.query(
    `SELECT l.access_id, l.workspace_id, l.user_id, u.email, l.artifact_type,
            l.artifact_id, l.action, l.nature_of_upsi, l.accessed_at,
            l.prev_hash, l.row_hash
     FROM upsi_access_log l
     JOIN users u ON u.user_id = l.user_id
     WHERE l.workspace_id = $1
     ORDER BY l.accessed_at, l.access_id`,
    [workspaceId],
  );
  return result.rows;
}

export async function verifyUpsIAccessChain(
  workspaceId: string,
): Promise<{ valid: boolean; count: number; error?: string }> {
  const rows = await listUpsIAccessLog(workspaceId);
  let previous = GENESIS_HASH;
  for (const row of rows) {
    const payload = {
      workspace_id: row.workspace_id,
      user_id: row.user_id,
      artifact_type: row.artifact_type,
      artifact_id: row.artifact_id,
      action: row.action,
      nature_of_upsi: row.nature_of_upsi,
      accessed_at: new Date(row.accessed_at).toISOString(),
    };
    const expected = computeChainHash(previous, stableStringify(payload));
    if (row.prev_hash !== previous || row.row_hash !== expected) {
      return { valid: false, count: rows.length, error: `Chain mismatch at ${row.access_id}` };
    }
    previous = row.row_hash;
  }
  const head = await pool.query<{ head_hash: string }>(
    `SELECT head_hash FROM upsi_access_chain_head WHERE workspace_id = $1`,
    [workspaceId],
  );
  const expectedHead = rows.length === 0 ? GENESIS_HASH : previous;
  const storedHead = head.rows[0]?.head_hash ?? GENESIS_HASH;
  if (storedHead !== expectedHead) {
    return {
      valid: false,
      count: rows.length,
      error: "Chain head does not match final access-log hash",
    };
  }
  return { valid: true, count: rows.length };
}

export async function configureWorkspaceSensitivity(input: {
  workspaceId: string;
  sensitivity: "public" | "confidential" | "upsi";
  natureOfUpsi?: string | null;
}) {
  const result = await pool.query(
    `UPDATE workspaces
     SET sensitivity = $2, nature_of_upsi = $3, updated_at = NOW()
     WHERE workspace_id = $1 AND status = 'active'
     RETURNING workspace_id, sensitivity, nature_of_upsi`,
    [input.workspaceId, input.sensitivity, input.natureOfUpsi ?? null],
  );
  if (!result.rows[0]) throw Object.assign(new Error("Workspace not found"), { status: 404 });
  return result.rows[0];
}

export async function listWorkspaceMemberships(workspaceId: string) {
  const result = await pool.query(
    `SELECT wm.workspace_id, wm.user_id, u.email, u.is_designated_person,
            wm.access_reason, wm.granted_by, wm.created_at
     FROM workspace_memberships wm
     JOIN users u ON u.user_id = wm.user_id
     WHERE wm.workspace_id = $1 ORDER BY wm.created_at`,
    [workspaceId],
  );
  return result.rows;
}

export async function grantWorkspaceMembership(input: {
  workspaceId: string;
  userId: string;
  grantedBy: string;
  accessReason: string;
}) {
  const result = await pool.query(
    `INSERT INTO workspace_memberships (
       workspace_id, user_id, granted_by, access_reason
     ) VALUES ($1,$2,$3,$4)
     ON CONFLICT (workspace_id, user_id)
     DO UPDATE SET access_reason = EXCLUDED.access_reason, granted_by = EXCLUDED.granted_by
     RETURNING workspace_id, user_id, access_reason, granted_by, created_at`,
    [input.workspaceId, input.userId, input.grantedBy, input.accessReason],
  );
  return result.rows[0];
}

export async function revokeWorkspaceMembership(workspaceId: string, userId: string): Promise<void> {
  const workspace = await pool.query<{ owner_id: string }>(
    `SELECT owner_id FROM workspaces WHERE workspace_id = $1`,
    [workspaceId],
  );
  if (!workspace.rows[0]) throw Object.assign(new Error("Workspace not found"), { status: 404 });
  if (workspace.rows[0].owner_id === userId) {
    throw Object.assign(new Error("Workspace owner membership cannot be revoked"), { status: 409 });
  }
  await pool.query(
    `DELETE FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2`,
    [workspaceId, userId],
  );
}
