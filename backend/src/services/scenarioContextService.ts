import { logger } from "../logger.js";
import { config } from "../config.js";
import { LruCache } from "../utils/lruCache.js";

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
  answerKind?: "accepted_recommendation" | "overridden" | "custom" | "comment";
  recommendedValue?: string;
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

// L1 cache only — Redis + scenarios.context_data are the durable stores, so
// bounding this is safe: a dropped/evicted entry is re-hydrated on next read
// (see hydrateScenarioContext). Sized generously for concurrent active
// scenarios; TTL mirrors session TTL so L1 doesn't outlive a session.
const scenarioContexts = new LruCache<string, ScenarioContext>({
  maxEntries: 2000,
  ttlMs: config.SESSION_TTL_MS,
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REDIS_KEY_PREFIX = "sm:ctx:";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let redisClientPromise: Promise<any | null> | null = null;

async function getRedisClient(): Promise<{
  get: (k: string) => Promise<string | null>;
  set: (k: string, v: string, ...args: unknown[]) => Promise<unknown>;
} | null> {
  if (!config.REDIS_URL) return null;
  if (!redisClientPromise) {
    redisClientPromise = (async () => {
      try {
        const mod = await import("ioredis");
        const RedisCtor =
          (mod as unknown as { default?: new (url: string, opts?: object) => unknown }).default ??
          (mod as unknown as new (url: string, opts?: object) => unknown);
        const client = new RedisCtor(config.REDIS_URL!, {
          maxRetriesPerRequest: 2,
          enableReadyCheck: true,
          lazyConnect: true,
        }) as { connect: () => Promise<void> };
        await client.connect();
        return client;
      } catch (e) {
        logger.warn(
          { detail: (e as Error).message },
          "[ScenarioContext] Redis unavailable — L1 + Postgres only",
        );
        return null;
      }
    })();
  }
  return redisClientPromise;
}

/** Test helper — drop Redis client singleton. */
export function resetScenarioContextRedisForTests(): void {
  redisClientPromise = null;
}

function redisKey(scenarioId: string): string {
  return `${REDIS_KEY_PREFIX}${scenarioId}`;
}

async function readRedis(scenarioId: string): Promise<ScenarioContext | null> {
  try {
    const client = await getRedisClient();
    if (!client) return null;
    const raw = await client.get(redisKey(scenarioId));
    if (!raw) return null;
    const data = JSON.parse(raw) as ScenarioContext;
    if (!data || !Array.isArray(data.touchedLevers)) return null;
    return data;
  } catch (e) {
    logger.warn({ detail: (e as Error).message }, "[ScenarioContext] Redis read failed (soft)");
    return null;
  }
}

async function writeRedis(scenarioId: string, ctx: ScenarioContext): Promise<void> {
  try {
    const client = await getRedisClient();
    if (!client) return;
    // Align TTL with session TTL when available
    const ttlSec = Math.max(60, Math.ceil(config.SESSION_TTL_MS / 1000));
    await client.set(redisKey(scenarioId), JSON.stringify(ctx), "EX", ttlSec);
  } catch (e) {
    logger.warn({ detail: (e as Error).message }, "[ScenarioContext] Redis write failed (soft)");
  }
}

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
 * Write-through persistence: L1 LruCache + optional Redis + scenarios.context_data.
 * Non-UUID ids (tests) skip durable stores.
 */
function persist(scenarioId: string): void {
  if (!UUID_RE.test(scenarioId)) return;
  const ctx = scenarioContexts.get(scenarioId);
  if (!ctx) return;
  void writeRedis(scenarioId, ctx);
  import("../db/index.js")
    .then(({ pool }) =>
      pool.query("UPDATE scenarios SET context_data = $2 WHERE scenario_id = $1", [
        scenarioId,
        JSON.stringify(ctx),
      ]),
    )
    .catch((e) =>
      logger.warn(
        { detail: (e as Error).message },
        `[ScenarioContext] Failed to persist ${scenarioId}:`,
      ),
    );
}

/**
 * Hydrate: L1 → Redis → Postgres. Returns cached/hydrated context when found.
 */
export async function hydrateScenarioContext(scenarioId: string): Promise<ScenarioContext | null> {
  const cached = scenarioContexts.get(scenarioId);
  if (cached) return cached;
  if (!UUID_RE.test(scenarioId)) return null;

  const fromRedis = await readRedis(scenarioId);
  if (fromRedis) {
    scenarioContexts.set(scenarioId, fromRedis);
    return fromRedis;
  }

  try {
    const { pool } = await import("../db/index.js");
    const r = await pool.query("SELECT context_data FROM scenarios WHERE scenario_id = $1", [
      scenarioId,
    ]);
    const data = r.rows[0]?.context_data as ScenarioContext | null | undefined;
    if (data && Array.isArray(data.touchedLevers)) {
      scenarioContexts.set(scenarioId, data);
      void writeRedis(scenarioId, data);
      return data;
    }
  } catch (e) {
    logger.warn(
      { detail: (e as Error).message },
      `[ScenarioContext] Failed to hydrate ${scenarioId}:`,
    );
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
  levers: Array<{
    id: string;
    value: number;
    confidence?: number;
    nlSource: string;
    source?: TouchedLever["source"];
  }>,
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
  meta?: {
    answerKind?: "accepted_recommendation" | "overridden" | "custom" | "comment";
    recommendedValue?: string;
  },
): ScenarioContext {
  const ctx = ensureScenarioContext(scenarioId);
  ctx.questionHistory.push({
    question,
    answer,
    parameterImpact,
    ...(meta?.answerKind ? { answerKind: meta.answerKind } : {}),
    ...(meta?.recommendedValue ? { recommendedValue: meta.recommendedValue } : {}),
  });
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

export function addConstraint(
  scenarioId: string,
  constraint: ScenarioConstraint,
): ScenarioContext {
  const ctx = ensureScenarioContext(scenarioId);
  const existing = ctx.constraints.findIndex(
    (c) => c.lever === constraint.lever && c.type === constraint.type,
  );
  if (existing >= 0) ctx.constraints[existing] = constraint;
  else ctx.constraints.push(constraint);
  persist(scenarioId);
  return ctx;
}

export function setConstraints(
  scenarioId: string,
  constraints: ScenarioConstraint[],
): ScenarioContext {
  const ctx = ensureScenarioContext(scenarioId);
  ctx.constraints = constraints;
  persist(scenarioId);
  return ctx;
}

export function clearConstraints(scenarioId: string): ScenarioContext {
  const ctx = ensureScenarioContext(scenarioId);
  ctx.constraints = [];
  persist(scenarioId);
  return ctx;
}

export interface ConstraintValidationResult {
  ok: boolean;
  violations: Array<{ lever: string; reason: string; value?: number; limit?: number }>;
}

/**
 * Validate absolute lever values against floor/ceiling constraints.
 * Missing levers are ignored (constraint only applies when the lever is present).
 */
export function validateAgainstConstraints(
  absoluteValues: Record<string, number>,
  constraints: ScenarioConstraint[],
): ConstraintValidationResult {
  const violations: ConstraintValidationResult["violations"] = [];
  for (const c of constraints ?? []) {
    const value = absoluteValues[c.lever];
    if (value == null || !Number.isFinite(value)) continue;
    if (c.type === "ceiling" && c.max != null && value > c.max) {
      violations.push({
        lever: c.lever,
        value,
        limit: c.max,
        reason: c.reason || `${c.lever} exceeds ceiling ${c.max}`,
      });
    }
    if (c.type === "floor" && c.min != null && value < c.min) {
      violations.push({
        lever: c.lever,
        value,
        limit: c.min,
        reason: c.reason || `${c.lever} below floor ${c.min}`,
      });
    }
  }
  return { ok: violations.length === 0, violations };
}

/** Serialize context for LLM prompts (touched levers + constraints). */
export function describeContextForLLM(ctx: ScenarioContext | null | undefined): string {
  if (!ctx) return "No prior scenario context.";
  const lines: string[] = [];
  lines.push(`Active scenario label: ${ctx.activeScenarioLabel || "Base"}`);
  if (ctx.touchedLevers.length) {
    lines.push("Already-touched levers (do NOT re-extract unless the user changes them):");
    for (const l of ctx.touchedLevers) {
      lines.push(
        `- ${l.id}: value=${l.userValue}, locked=${l.locked}, source=${l.source}, nl="${l.nlSource}"`,
      );
    }
  } else {
    lines.push("No touched levers yet.");
  }
  if (ctx.constraints.length) {
    lines.push("Hard constraints (must not be violated):");
    for (const c of ctx.constraints) {
      lines.push(
        `- ${c.type} on ${c.lever}: ${c.type === "ceiling" ? `max=${c.max}` : `min=${c.min}`} (${c.reason})`,
      );
    }
  }
  if (ctx.questionHistory.length) {
    lines.push("Recent Q&A:");
    for (const q of ctx.questionHistory.slice(-5)) {
      lines.push(`- Q: ${q.question} → A: ${q.answer}`);
    }
  }
  return lines.join("\n");
}
