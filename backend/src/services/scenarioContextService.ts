import { logger } from "../logger.js";
export interface TouchedLever {
  id: string;
  originalValue: number;
  userValue: number;
  source: "user_override" | "parser_extract" | "manual_override";
  confidence: number;
  nlSource: string;
  locked: boolean;
}

export interface ScenarioConstraint {
  type: "ceiling" | "floor";
  lever: string;
  max?: number;
  min?: number;
  reason: string;
}

export interface ScenarioQuestionHistory {
  question: string;
  answer: string;
  parameterImpact: string[];
}

export interface ScenarioComparisonVersion {
  label: string;
  touchedLevers: TouchedLever[];
  outputs: Record<string, number>;
}

export interface ScenarioContext {
  modelSchema?: Record<string, unknown>;
  workbookGraph?: Record<string, unknown>;
  activeScenarioLabel: string;
  touchedLevers: TouchedLever[];
  constraints: ScenarioConstraint[];
  questionHistory: ScenarioQuestionHistory[];
  comparisonVersions: ScenarioComparisonVersion[];
}

const scenarioContexts = new Map<string, ScenarioContext>();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function defaultContext(): ScenarioContext {
  return {
    activeScenarioLabel: "Base",
    touchedLevers: [],
    constraints: [],
    questionHistory: [],
    comparisonVersions: [],
  };
}

/**
 * Write-through persistence to scenarios.context_data (fire-and-forget so
 * the synchronous mutator API stays intact). Non-UUID ids (tests) skip DB.
 */
function persist(scenarioId: string): void {
  if (!UUID_RE.test(scenarioId)) return;
  const ctx = scenarioContexts.get(scenarioId);
  if (!ctx) return;
  import("../db/index.js")
    .then(({ pool }) =>
      pool.query("UPDATE scenarios SET context_data = $2 WHERE scenario_id = $1", [
        scenarioId,
        JSON.stringify(ctx),
      ]),
    )
    .catch((e) => logger.warn({ detail: (e as Error).message }, `[ScenarioContext] Failed to persist ${scenarioId}:`));
}

/**
 * Load a persisted context into the cache (call at the start of any route
 * that reads or mutates context, so state survives restarts). Returns the
 * cached context when already loaded.
 */
export async function hydrateScenarioContext(scenarioId: string): Promise<ScenarioContext | null> {
  const cached = scenarioContexts.get(scenarioId);
  if (cached) return cached;
  if (!UUID_RE.test(scenarioId)) return null;
  try {
    const { pool } = await import("../db/index.js");
    const r = await pool.query("SELECT context_data FROM scenarios WHERE scenario_id = $1", [scenarioId]);
    const data = r.rows[0]?.context_data as ScenarioContext | null | undefined;
    if (data && Array.isArray(data.touchedLevers)) {
      scenarioContexts.set(scenarioId, data);
      return data;
    }
  } catch (e) {
    logger.warn({ detail: (e as Error).message }, `[ScenarioContext] Failed to hydrate ${scenarioId}:`);
  }
  return null;
}

export function ensureScenarioContext(
  scenarioId: string,
  seed?: Partial<ScenarioContext>,
): ScenarioContext {
  const existing = scenarioContexts.get(scenarioId);
  if (existing) return existing;
  const ctx = { ...defaultContext(), ...seed };
  scenarioContexts.set(scenarioId, ctx);
  // No persist here: an empty default must not overwrite a stored context
  // that simply hasn't been hydrated yet. Mutators persist.
  return ctx;
}

export function getScenarioContext(scenarioId: string): ScenarioContext | null {
  return scenarioContexts.get(scenarioId) || null;
}

export function mergeTouchedLevers(
  scenarioId: string,
  levers: Array<{ id: string; value: number; confidence?: number; nlSource: string; source?: TouchedLever["source"] }>,
): ScenarioContext {
  const ctx = ensureScenarioContext(scenarioId);
  for (const lever of levers) {
    const existing = ctx.touchedLevers.find((l) => l.id === lever.id);
    if (existing) {
      existing.userValue = lever.value;
      existing.confidence = lever.confidence ?? existing.confidence;
      existing.nlSource = lever.nlSource;
      if (lever.source) existing.source = lever.source;
      continue;
    }
    ctx.touchedLevers.push({
      id: lever.id,
      originalValue: lever.value,
      userValue: lever.value,
      source: lever.source || "parser_extract",
      confidence: lever.confidence ?? 1,
      nlSource: lever.nlSource,
      locked: false,
    });
  }
  persist(scenarioId);
  return ctx;
}

export function lockLever(scenarioId: string, leverId: string, locked: boolean): ScenarioContext {
  const ctx = ensureScenarioContext(scenarioId);
  const lever = ctx.touchedLevers.find((l) => l.id === leverId);
  if (lever) lever.locked = locked;
  persist(scenarioId);
  return ctx;
}

export function resetUnlockedLevers(scenarioId: string): ScenarioContext {
  const ctx = ensureScenarioContext(scenarioId);
  ctx.touchedLevers = ctx.touchedLevers.filter((l) => l.locked);
  persist(scenarioId);
  return ctx;
}

export function addQuestionHistory(
  scenarioId: string,
  question: string,
  answer: string,
  parameterImpact: string[],
): ScenarioContext {
  const ctx = ensureScenarioContext(scenarioId);
  ctx.questionHistory.push({ question, answer, parameterImpact });
  persist(scenarioId);
  return ctx;
}

export function addComparisonVersion(
  scenarioId: string,
  label: string,
  outputs: Record<string, number>,
): ScenarioContext {
  const ctx = ensureScenarioContext(scenarioId);
  ctx.comparisonVersions.push({
    label,
    touchedLevers: JSON.parse(JSON.stringify(ctx.touchedLevers)),
    outputs,
  });
  persist(scenarioId);
  return ctx;
}

export function getTouchedLeverSnapshot(scenarioId: string): TouchedLever[] {
  const ctx = ensureScenarioContext(scenarioId);
  return JSON.parse(JSON.stringify(ctx.touchedLevers));
}
