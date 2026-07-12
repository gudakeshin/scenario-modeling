/**
 * Conversational Session Service
 *
 * Manages multi-turn chat sessions so follow-up queries like
 * "also increase marketing 10%" accumulate parameters additively
 * on the same scenario rather than creating a new one.
 *
 * Backing store: Memory (default) or Redis when REDIS_URL is configured.
 * TTL is unified via config.SESSION_TTL_MS.
 */

import { pool } from "../db/index.js";
import { config } from "../config.js";
import { parseScenario, toTypedDelta } from "./parser.js";
import { resolveToModelVariable } from "./mappingService.js";
import { logAudit } from "./auditService.js";
import {
  ensureScenarioContext,
  mergeTouchedLevers,
  getScenarioContext,
  hydrateScenarioContext,
} from "./scenarioContextService.js";
import { getSessionStore, type StoredSession } from "./sessionStore.js";

export interface Session {
  session_id: string;
  scenario_id: string;
  user_id: string;
  turns: { role: "user" | "assistant"; content: string; timestamp: string }[];
  scenario_context?: ReturnType<typeof getScenarioContext>;
  expires_at: string;
  created_at: string;
}

const SESSION_TTL_MS = config.SESSION_TTL_MS;

function generateSessionId(): string {
  return "sess_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function rowToStored(row: {
  scenario_id: string;
  user_id: string;
  turns: unknown;
  expires_at: Date | string;
  created_at: Date | string;
}): StoredSession | null {
  const expiresAt = new Date(row.expires_at).getTime();
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return null;
  const turns = Array.isArray(row.turns)
    ? (row.turns as StoredSession["turns"])
    : typeof row.turns === "string"
      ? (JSON.parse(row.turns) as StoredSession["turns"])
      : [];
  return {
    scenario_id: row.scenario_id,
    user_id: row.user_id,
    turns,
    expires_at: expiresAt,
    created_at: new Date(row.created_at).getTime(),
  };
}

/** Postgres dual-read when Redis/memory miss — rehydrate hot store. */
async function loadSessionFromPostgres(sessionId: string): Promise<StoredSession | null> {
  try {
    const r = await pool.query(
      `SELECT scenario_id, user_id, turns, expires_at, created_at
       FROM sessions WHERE session_id = $1 AND expires_at > NOW()`,
      [sessionId],
    );
    if (!r.rows[0]) return null;
    return rowToStored(r.rows[0]);
  } catch {
    return null;
  }
}

async function listSessionsFromPostgres(
  userId?: string,
): Promise<Array<{ id: string; session: StoredSession }>> {
  try {
    const r = userId
      ? await pool.query(
          `SELECT session_id, scenario_id, user_id, turns, expires_at, created_at
           FROM sessions WHERE user_id = $1 AND expires_at > NOW()
           ORDER BY updated_at DESC NULLS LAST, created_at DESC`,
          [userId],
        )
      : await pool.query(
          `SELECT session_id, scenario_id, user_id, turns, expires_at, created_at
           FROM sessions WHERE expires_at > NOW()
           ORDER BY updated_at DESC NULLS LAST, created_at DESC`,
        );
    const out: Array<{ id: string; session: StoredSession }> = [];
    for (const row of r.rows) {
      const session = rowToStored(row);
      if (session) out.push({ id: row.session_id, session });
    }
    return out;
  } catch {
    return [];
  }
}

function toPublicSession(sessionId: string, s: StoredSession): Session {
  return {
    session_id: sessionId,
    scenario_id: s.scenario_id,
    user_id: s.user_id,
    turns: s.turns,
    scenario_context: getScenarioContext(s.scenario_id),
    expires_at: new Date(s.expires_at).toISOString(),
    created_at: new Date(s.created_at).toISOString(),
  };
}

export async function getSession(sessionId: string): Promise<Session | null> {
  const store = await getSessionStore();
  let s = await store.get(sessionId);
  if (!s) {
    s = await loadSessionFromPostgres(sessionId);
    if (s) {
      const ttl = Math.max(1, s.expires_at - Date.now());
      try {
        await store.set(sessionId, s, ttl);
      } catch {
        /* rehydrate is best-effort */
      }
    }
  }
  if (!s) return null;
  return toPublicSession(sessionId, s);
}

export async function createSession(scenarioId: string, userId: string): Promise<string> {
  const store = await getSessionStore();
  const id = generateSessionId();
  await hydrateScenarioContext(scenarioId);
  ensureScenarioContext(scenarioId);
  const now = Date.now();
  const session = {
    scenario_id: scenarioId,
    user_id: userId,
    turns: [] as { role: "user" | "assistant"; content: string; timestamp: string }[],
    expires_at: now + SESSION_TTL_MS,
    created_at: now,
  };
  await store.set(id, session, SESSION_TTL_MS);

  // Dual-write to Postgres sessions table for durability / restart recovery
  try {
    await pool.query(
      `INSERT INTO sessions (session_id, scenario_id, user_id, turns, expires_at, scenario_context)
       VALUES ($1, $2, $3, $4::jsonb, to_timestamp($5 / 1000.0), $6::jsonb)
       ON CONFLICT (session_id) DO UPDATE SET
         turns = EXCLUDED.turns,
         expires_at = EXCLUDED.expires_at,
         updated_at = NOW()`,
      [
        id,
        scenarioId,
        userId,
        JSON.stringify([]),
        session.expires_at,
        JSON.stringify(getScenarioContext(scenarioId) ?? {}),
      ],
    );
  } catch (e) {
    // Non-fatal — cache remains authoritative for hot path
    void e;
  }

  return id;
}

export async function resetSession(sessionId: string): Promise<boolean> {
  const store = await getSessionStore();
  const deleted = await store.delete(sessionId);
  try {
    await pool.query("DELETE FROM sessions WHERE session_id = $1", [sessionId]);
  } catch {
    /* ignore */
  }
  return deleted;
}

export async function listSessions(userId?: string): Promise<Session[]> {
  const store = await getSessionStore();
  const cached = await store.list(userId);
  const byId = new Map(cached.map((c) => [c.id, c.session]));

  // Merge Postgres dual-read so cold sessions after restart still appear
  const durable = await listSessionsFromPostgres(userId);
  for (const { id, session } of durable) {
    if (!byId.has(id)) {
      byId.set(id, session);
      const ttl = Math.max(1, session.expires_at - Date.now());
      try {
        await store.set(id, session, ttl);
      } catch {
        /* ignore */
      }
    }
  }

  return [...byId.entries()].map(([id, s]) => toPublicSession(id, s));
}

/**
 * Process a follow-up turn within an existing session.
 */
export async function addFollowUp(
  sessionId: string,
  nlInput: string,
  userId: string,
): Promise<{
  added_parameters: { name: string; mapped_variable_id: string; scenario_value: number }[];
  cumulative_count: number;
  clarification_needed?: string;
}> {
  const store = await getSessionStore();
  const session = await store.get(sessionId);
  if (!session) throw new Error("Session not found or expired");

  session.expires_at = Date.now() + SESSION_TTL_MS;
  session.turns.push({ role: "user", content: nlInput, timestamp: new Date().toISOString() });

  const scenarioId = session.scenario_id;
  await hydrateScenarioContext(scenarioId);
  const creatorRes = await pool.query(
    "SELECT creator_id, workspace_id FROM scenarios WHERE scenario_id = $1",
    [scenarioId],
  );
  const creatorId = creatorRes.rows[0]?.creator_id;
  let scenarioWorkspaceId: string | undefined = creatorRes.rows[0]?.workspace_id ?? undefined;
  if (creatorId && !scenarioWorkspaceId) {
    const { ensureDefaultWorkspace } = await import("./workspaceService.js");
    scenarioWorkspaceId = await ensureDefaultWorkspace(creatorId);
  }
  const parseResult = await parseScenario(
    nlInput,
    creatorId && scenarioWorkspaceId
      ? { userId: creatorId, workspaceId: scenarioWorkspaceId }
      : undefined,
    scenarioId,
  );

  const added: { name: string; mapped_variable_id: string; scenario_value: number }[] = [];

  for (const p of parseResult.parameters) {
    let variableId: string | null = p.suggested_variable_id || null;
    if (!variableId) {
      variableId =
        (await resolveToModelVariable(p.name)) ||
        (p.scope?.category ? await resolveToModelVariable(p.scope.category) : null) ||
        (p.scope?.geography ? await resolveToModelVariable(`geo_${p.scope.geography}`) : null);
    }
    if (!variableId) {
      variableId = `extracted_${p.name.replace(/\W+/g, "_").toLowerCase()}`;
    }
    const { value: scenarioValue, delta_type: deltaType } = toTypedDelta(p);

    const existing = await pool.query(
      "SELECT parameter_id, scenario_value FROM scenario_parameters WHERE scenario_id = $1 AND mapped_variable_id = $2 AND status != 'rejected'",
      [scenarioId, variableId],
    );

    if (existing.rows.length > 0) {
      await pool.query(
        "UPDATE scenario_parameters SET scenario_value = $1, delta_type = $2, status = 'modified', extracted_name = $3, member_scope = $4 WHERE parameter_id = $5",
        [
          scenarioValue,
          deltaType,
          p.name,
          p.member_scope ? JSON.stringify(p.member_scope) : null,
          existing.rows[0].parameter_id,
        ],
      );
    } else {
      await pool.query(
        `INSERT INTO scenario_parameters (scenario_id, extracted_name, mapped_variable_id, scenario_value, delta_type, confidence_score, status, member_scope)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7)`,
        [
          scenarioId,
          p.name,
          variableId,
          scenarioValue,
          deltaType,
          p.confidence,
          p.member_scope ? JSON.stringify(p.member_scope) : null,
        ],
      );
    }

    added.push({ name: p.name, mapped_variable_id: variableId, scenario_value: scenarioValue });
  }
  mergeTouchedLevers(
    scenarioId,
    added.map((a) => ({
      id: a.mapped_variable_id,
      value: a.scenario_value,
      confidence: 1,
      nlSource: nlInput,
      source: "parser_extract" as const,
    })),
  );

  await pool.query(
    "UPDATE scenarios SET status = 'draft', updated_at = NOW() WHERE scenario_id = $1",
    [scenarioId],
  );
  await logAudit(scenarioId, "follow_up", { nl_input: nlInput, added_count: added.length }, userId);

  const countRes = await pool.query(
    "SELECT COUNT(*) FROM scenario_parameters WHERE scenario_id = $1 AND status != 'rejected'",
    [scenarioId],
  );
  const cumulativeCount = parseInt(countRes.rows[0].count, 10);

  const assistantContent =
    added.length > 0
      ? `Added/updated ${added.length} parameter(s). Total active: ${cumulativeCount}.`
      : parseResult.clarification_needed || "No parameters extracted from follow-up.";

  session.turns.push({
    role: "assistant",
    content: assistantContent,
    timestamp: new Date().toISOString(),
  });
  await store.set(sessionId, session, SESSION_TTL_MS);

  try {
    await pool.query(
      `UPDATE sessions SET turns = $2::jsonb, expires_at = to_timestamp($3 / 1000.0), updated_at = NOW()
       WHERE session_id = $1`,
      [sessionId, JSON.stringify(session.turns), session.expires_at],
    );
  } catch {
    /* ignore */
  }

  return {
    added_parameters: added,
    cumulative_count: cumulativeCount,
    clarification_needed: parseResult.clarification_needed,
  };
}
