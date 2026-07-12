/**
 * Conversational Session Service
 *
 * Manages multi-turn chat sessions so follow-up queries like
 * "also increase marketing 10%" accumulate parameters additively
 * on the same scenario rather than creating a new one.
 *
 * Sessions expire after 24 hours of inactivity.
 */

import { pool } from "../db/index.js";
import { parseScenario, toTypedDelta } from "./parser.js";
import { resolveToModelVariable } from "./mappingService.js";
import { logAudit } from "./auditService.js";
import { ensureScenarioContext, mergeTouchedLevers, getScenarioContext, hydrateScenarioContext } from "./scenarioContextService.js";

export interface Session {
  session_id: string;
  scenario_id: string;
  user_id: string;
  turns: { role: "user" | "assistant"; content: string; timestamp: string }[];
  scenario_context?: ReturnType<typeof getScenarioContext>;
  expires_at: string;
  created_at: string;
}

const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS) || 24 * 60 * 60 * 1000; // 24 hours default

// In-memory session store (swap for Redis in production)
const sessions = new Map<string, {
  scenario_id: string;
  user_id: string;
  turns: { role: "user" | "assistant"; content: string; timestamp: string }[];
  expires_at: number;
  created_at: number;
}>();

function generateSessionId(): string {
  return "sess_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function cleanExpired() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now > s.expires_at) sessions.delete(id);
  }
}

export function getSession(sessionId: string): Session | null {
  cleanExpired();
  const s = sessions.get(sessionId);
  if (!s) return null;
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

export async function createSession(scenarioId: string, userId: string): Promise<string> {
  cleanExpired();
  const id = generateSessionId();
  await hydrateScenarioContext(scenarioId);
  ensureScenarioContext(scenarioId);
  sessions.set(id, {
    scenario_id: scenarioId,
    user_id: userId,
    turns: [],
    expires_at: Date.now() + SESSION_TTL_MS,
    created_at: Date.now(),
  });
  return id;
}

export function resetSession(sessionId: string): boolean {
  return sessions.delete(sessionId);
}

export function listSessions(userId?: string): Session[] {
  cleanExpired();
  const result: Session[] = [];
  for (const [id, s] of sessions) {
    if (userId && s.user_id !== userId) continue;
    result.push({
      session_id: id,
      scenario_id: s.scenario_id,
      user_id: s.user_id,
      turns: s.turns,
      scenario_context: getScenarioContext(s.scenario_id),
      expires_at: new Date(s.expires_at).toISOString(),
      created_at: new Date(s.created_at).toISOString(),
    });
  }
  return result;
}

/**
 * Process a follow-up turn within an existing session.
 * Parses the new NL input, resolves variables, and adds them
 * as additional parameters to the existing scenario.
 */
export async function addFollowUp(
  sessionId: string,
  nlInput: string,
  userId: string
): Promise<{
  added_parameters: { name: string; mapped_variable_id: string; scenario_value: number }[];
  cumulative_count: number;
  clarification_needed?: string;
}> {
  cleanExpired();
  const session = sessions.get(sessionId);
  if (!session) throw new Error("Session not found or expired");

  // Extend session TTL
  session.expires_at = Date.now() + SESSION_TTL_MS;
  session.turns.push({ role: "user", content: nlInput, timestamp: new Date().toISOString() });

  const scenarioId = session.scenario_id;
  await hydrateScenarioContext(scenarioId);
  // Parse against the scenario's own workspace (not the caller's active
  // one) so follow-ups always resolve the model the scenario was built on.
  const creatorRes = await pool.query(
    "SELECT creator_id, workspace_id FROM scenarios WHERE scenario_id = $1",
    [scenarioId]
  );
  const creatorId = creatorRes.rows[0]?.creator_id;
  let scenarioWorkspaceId: string | undefined = creatorRes.rows[0]?.workspace_id ?? undefined;
  if (creatorId && !scenarioWorkspaceId) {
    const { ensureDefaultWorkspace } = await import("./workspaceService.js");
    scenarioWorkspaceId = await ensureDefaultWorkspace(creatorId);
  }
  const parseResult = await parseScenario(
    nlInput,
    creatorId && scenarioWorkspaceId ? { userId: creatorId, workspaceId: scenarioWorkspaceId } : undefined
  );

  const added: { name: string; mapped_variable_id: string; scenario_value: number }[] = [];

  for (const p of parseResult.parameters) {
    // Resolution priority: 1) Parser's suggested_variable_id, 2) DB mapping, 3) Synthetic fallback
    let variableId: string | null = p.suggested_variable_id || null;
    if (!variableId) {
      variableId = await resolveToModelVariable(p.name)
        || (p.scope?.category ? await resolveToModelVariable(p.scope.category) : null)
        || (p.scope?.geography ? await resolveToModelVariable(`geo_${p.scope.geography}`) : null);
    }
    if (!variableId) {
      variableId = `extracted_${p.name.replace(/\W+/g, "_").toLowerCase()}`;
    }
    const { value: scenarioValue, delta_type: deltaType } = toTypedDelta(p);

    // Check if parameter for this variable already exists
    const existing = await pool.query(
      "SELECT parameter_id, scenario_value FROM scenario_parameters WHERE scenario_id = $1 AND mapped_variable_id = $2 AND status != 'rejected'",
      [scenarioId, variableId]
    );

    if (existing.rows.length > 0) {
      // Update existing parameter (additive)
      await pool.query(
        "UPDATE scenario_parameters SET scenario_value = $1, delta_type = $2, status = 'modified', extracted_name = $3, member_scope = $4 WHERE parameter_id = $5",
        [
          scenarioValue,
          deltaType,
          p.name,
          p.member_scope ? JSON.stringify(p.member_scope) : null,
          existing.rows[0].parameter_id,
        ]
      );
    } else {
      // Insert new parameter
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
        ]
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

  // Reset scenario to draft so it needs re-approval
  await pool.query("UPDATE scenarios SET status = 'draft', updated_at = NOW() WHERE scenario_id = $1", [scenarioId]);
  await logAudit(scenarioId, "follow_up", { nl_input: nlInput, added_count: added.length }, userId);

  // Count cumulative params
  const countRes = await pool.query(
    "SELECT COUNT(*) FROM scenario_parameters WHERE scenario_id = $1 AND status != 'rejected'",
    [scenarioId]
  );
  const cumulativeCount = parseInt(countRes.rows[0].count, 10);

  const assistantContent = added.length > 0
    ? `Added/updated ${added.length} parameter(s). Total active: ${cumulativeCount}.`
    : parseResult.clarification_needed || "No parameters extracted from follow-up.";

  session.turns.push({ role: "assistant", content: assistantContent, timestamp: new Date().toISOString() });

  return {
    added_parameters: added,
    cumulative_count: cumulativeCount,
    clarification_needed: parseResult.clarification_needed,
  };
}
