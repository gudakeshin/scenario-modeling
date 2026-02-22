/**
 * Conversational Session Service
 *
 * Manages multi-turn chat sessions so follow-up queries like
 * "also increase marketing 10%" accumulate parameters additively
 * on the same scenario rather than creating a new one.
 *
 * Sessions expire after 24 hours of inactivity.
 */

import { pool, getDefaultUserId } from "../db/index.js";
import { parseScenario } from "./parser.js";
import { resolveToModelVariable } from "./mappingService.js";
import { logAudit } from "./auditService.js";

export interface Session {
  session_id: string;
  scenario_id: string;
  user_id: string;
  turns: { role: "user" | "assistant"; content: string; timestamp: string }[];
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
    expires_at: new Date(s.expires_at).toISOString(),
    created_at: new Date(s.created_at).toISOString(),
  };
}

export function createSession(scenarioId: string, userId: string): string {
  cleanExpired();
  const id = generateSessionId();
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
  nlInput: string
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
  // Get the scenario's creator for model lookup
  const creatorRes = await pool.query("SELECT creator_id FROM scenarios WHERE scenario_id = $1", [scenarioId]);
  const creatorId = creatorRes.rows[0]?.creator_id;
  const parseResult = await parseScenario(nlInput, creatorId);

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
    const scenarioValue = (p.magnitude != null && !isNaN(Number(p.magnitude))) ? Number(p.magnitude) : 0;

    // Check if parameter for this variable already exists
    const existing = await pool.query(
      "SELECT parameter_id, scenario_value FROM scenario_parameters WHERE scenario_id = $1 AND mapped_variable_id = $2 AND status != 'rejected'",
      [scenarioId, variableId]
    );

    if (existing.rows.length > 0) {
      // Update existing parameter (additive)
      await pool.query(
        "UPDATE scenario_parameters SET scenario_value = $1, status = 'modified', extracted_name = $2 WHERE parameter_id = $3",
        [scenarioValue, p.name, existing.rows[0].parameter_id]
      );
    } else {
      // Insert new parameter
      await pool.query(
        `INSERT INTO scenario_parameters (scenario_id, extracted_name, mapped_variable_id, scenario_value, confidence_score, status)
         VALUES ($1, $2, $3, $4, $5, 'pending')`,
        [scenarioId, p.name, variableId, scenarioValue, p.confidence]
      );
    }

    added.push({ name: p.name, mapped_variable_id: variableId, scenario_value: scenarioValue });
  }

  // Reset scenario to draft so it needs re-approval
  await pool.query("UPDATE scenarios SET status = 'draft', updated_at = NOW() WHERE scenario_id = $1", [scenarioId]);
  await logAudit(scenarioId, "follow_up", { nl_input: nlInput, added_count: added.length });

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
