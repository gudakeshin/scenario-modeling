/**
 * Model registry: definitions loaded from user_models DB table or external API.
 *
 * All base values, metric lists, and variable classifications are
 * DERIVED from the model definition — never hardcoded elsewhere.
 *
 * Models are created dynamically by the Context Engine from uploaded documents.
 */

import { pool } from "../db/index.js";

export interface ModelVariable {
  id: string;
  name: string;
  formula: string;
  dependencies: string[];
  tags?: string[];
}

export interface TimeHorizon {
  start: string;
  end: string;
  granularity: "monthly" | "quarterly";
}

export interface ModelDefinition {
  model_version: string;
  variables: ModelVariable[];
  time_horizon: TimeHorizon;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Get a model definition by model_id (UUID) or version string.
 * Returns null if no model is found — callers should handle the onboarding case.
 */
export async function getModelDefinition(modelIdOrVersion?: string): Promise<ModelDefinition | null> {
  // 1. If it's a UUID, look up in user_models by model_id
  if (modelIdOrVersion && UUID_RE.test(modelIdOrVersion)) {
    const r = await pool.query("SELECT model_definition FROM user_models WHERE model_id = $1", [modelIdOrVersion]);
    if (r.rows.length > 0) return r.rows[0].model_definition as ModelDefinition;
  }

  // 2. Try external model registry API
  const envUrl = process.env.MODEL_REGISTRY_URL;
  if (envUrl && modelIdOrVersion) {
    try {
      const res = await fetch(`${envUrl}/models/${modelIdOrVersion}`);
      if (res.ok) return (await res.json()) as ModelDefinition;
    } catch {
      // fallback
    }
  }

  // 3. No model found — return null (triggers onboarding)
  return null;
}

/**
 * Get the active model for a specific user.
 * This is the primary way to get a model at scenario creation time.
 */
export async function getUserModelDefinition(userId: string): Promise<ModelDefinition | null> {
  const r = await pool.query(
    "SELECT model_definition FROM user_models WHERE created_by = $1 AND is_active = true ORDER BY created_at DESC LIMIT 1",
    [userId]
  );
  if (r.rows.length > 0) return r.rows[0].model_definition as ModelDefinition;
  return null;
}

/**
 * Get the active model_id for a user (to store on scenarios).
 */
export async function getUserModelId(userId: string): Promise<string | null> {
  const r = await pool.query(
    "SELECT model_id FROM user_models WHERE created_by = $1 AND is_active = true ORDER BY created_at DESC LIMIT 1",
    [userId]
  );
  if (r.rows.length > 0) return r.rows[0].model_id;
  return null;
}

// ── Derived helpers (single source of truth) ──

function topologicalSort(variables: ModelVariable[]): string[] {
  const order: string[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const byId = new Map(variables.map((v) => [v.id, v]));
  function visit(id: string) {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`Circular dependency: ${id}`);
    visiting.add(id);
    const v = byId.get(id);
    if (v) for (const d of v.dependencies) visit(d);
    visiting.delete(id);
    visited.add(id);
    order.push(id);
  }
  for (const v of variables) visit(v.id);
  return order;
}

function evaluateFormula(formula: string, ctx: Record<string, number>): number {
  let expr = formula.trim();
  for (const [k, v] of Object.entries(ctx)) {
    expr = expr.replace(new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"), String(v));
  }
  if (!/^[\d\s+\-*/().]+$/.test(expr)) return 0;
  try {
    return new Function(`return (${expr})`)();
  } catch {
    return 0;
  }
}

/**
 * Compute the base case P&L from a model definition.
 * Accepts a model directly, or looks it up by ID/version.
 */
export async function computeBaseCase(modelOrVersion?: string | ModelDefinition): Promise<Record<string, number>> {
  let model: ModelDefinition | null;
  if (modelOrVersion && typeof modelOrVersion === "object") {
    model = modelOrVersion;
  } else {
    model = await getModelDefinition(modelOrVersion as string | undefined);
  }
  if (!model) return {};
  const order = topologicalSort(model.variables);
  const ctx: Record<string, number> = {};
  for (const id of order) {
    const v = model.variables.find((x) => x.id === id);
    if (!v) continue;
    ctx[id] = evaluateFormula(v.formula, ctx);
  }
  return ctx;
}

/**
 * Get the list of P&L metric variable IDs from model tags.
 */
export function getPLMetrics(model: ModelDefinition): string[] {
  return model.variables.filter((v) => v.tags?.includes("pl_metric")).map((v) => v.id);
}

/**
 * Get the set of variables that accept percent-delta overrides.
 */
export function getPercentDeltaVars(model: ModelDefinition): Set<string> {
  return new Set(model.variables.filter((v) => v.tags?.includes("percent_delta")).map((v) => v.id));
}

/**
 * Get input variables (leaves with no dependencies) — for sensitivity analysis.
 */
export function getInputVariables(model: ModelDefinition): ModelVariable[] {
  return model.variables.filter((v) => v.dependencies.length === 0);
}

/**
 * Build a description of the model for LLM context.
 */
export function describeModelForLLM(model: ModelDefinition): string {
  const lines = [`Financial Model (${model.model_version})`, `Time: ${model.time_horizon.start} to ${model.time_horizon.end}`, "", "Variables:"];
  for (const v of model.variables) {
    const tags = v.tags?.length ? ` [${v.tags.join(", ")}]` : "";
    lines.push(`  - ${v.id} (${v.name}): ${v.formula}${tags}`);
  }
  return lines.join("\n");
}
