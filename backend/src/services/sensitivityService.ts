/**
 * Sensitivity Analysis / Tornado Chart Service
 *
 * For each input variable, perturbs it ±X% from its base value
 * while holding everything else constant, and measures the impact
 * on a target metric (default: net_income). Produces ranked bars
 * for a tornado chart.
 */

import { pool } from "../db/index.js";
import { getModelDefinition, getInputVariables as getModelInputVars, type ModelVariable } from "../models/registry.js";

export interface TornadoBar {
  variable_id: string;
  variable_name: string;
  low_value: number;    // metric value when variable is at -swing%
  high_value: number;   // metric value when variable is at +swing%
  base_value: number;   // metric value at base
  low_delta: number;    // low_value - base_value
  high_delta: number;   // high_value - base_value
  spread: number;       // |high_value - low_value|
}

export interface SensitivityResult {
  target_metric: string;
  swing_pct: number;
  base_metric_value: number;
  bars: TornadoBar[];
}

// ── Helpers (isolated copies) ──

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
  return order; // DFS post-order: dependencies are pushed before dependents
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

function evalModel(
  order: string[],
  variables: ModelVariable[],
  overrides: Record<string, number>
): Record<string, number> {
  const ctx: Record<string, number> = {};
  for (const id of order) {
    if (id in overrides) {
      ctx[id] = overrides[id];
      continue;
    }
    const v = variables.find((x) => x.id === id);
    if (!v) continue;
    ctx[id] = evaluateFormula(v.formula, ctx);
  }
  return ctx;
}

export async function runSensitivity(
  scenarioId: string,
  targetMetric = "net_income",
  swingPct = 20
): Promise<SensitivityResult> {
  const scenarioRes = await pool.query("SELECT model_version_hash FROM scenarios WHERE scenario_id = $1", [scenarioId]);
  if (scenarioRes.rows.length === 0) throw new Error("Scenario not found");

  const model = await getModelDefinition(scenarioRes.rows[0].model_version_hash);
  if (!model) throw new Error("No model found. Please build a model from your documents first.");
  const order = topologicalSort(model.variables);
  const inputs = getModelInputVars(model);

  // Load scenario overrides
  const paramsRes = await pool.query(
    "SELECT mapped_variable_id, scenario_value FROM scenario_parameters WHERE scenario_id = $1 AND status IN ('pending','accepted','modified')",
    [scenarioId]
  );
  const scenarioOverrides: Record<string, number> = {};
  for (const row of paramsRes.rows) {
    scenarioOverrides[row.mapped_variable_id] = Number(row.scenario_value);
  }

  // Base run
  const baseCtx = evalModel(order, model.variables, {});
  const baseMetricValue = baseCtx[targetMetric] ?? 0;

  const bars: TornadoBar[] = [];
  const swing = swingPct / 100;

  for (const input of inputs) {
    const baseVal = baseCtx[input.id] ?? 0;
    if (baseVal === 0) continue;

    const lowOverrides = { [input.id]: baseVal * (1 - swing) };
    const highOverrides = { [input.id]: baseVal * (1 + swing) };

    const lowCtx = evalModel(order, model.variables, lowOverrides);
    const highCtx = evalModel(order, model.variables, highOverrides);

    const lowMetric = Math.round((lowCtx[targetMetric] ?? 0) * 100) / 100;
    const highMetric = Math.round((highCtx[targetMetric] ?? 0) * 100) / 100;

    bars.push({
      variable_id: input.id,
      variable_name: input.name,
      low_value: lowMetric,
      high_value: highMetric,
      base_value: Math.round(baseMetricValue * 100) / 100,
      low_delta: Math.round((lowMetric - baseMetricValue) * 100) / 100,
      high_delta: Math.round((highMetric - baseMetricValue) * 100) / 100,
      spread: Math.round(Math.abs(highMetric - lowMetric) * 100) / 100,
    });
  }

  // Sort by spread descending (widest impact first)
  bars.sort((a, b) => b.spread - a.spread);

  // Store result
  await pool.query(
    `INSERT INTO scenario_outputs (scenario_id, output_type, output_data) VALUES ($1, 'sensitivity', $2)`,
    [scenarioId, JSON.stringify({ target_metric: targetMetric, swing_pct: swingPct, bars })]
  );

  return {
    target_metric: targetMetric,
    swing_pct: swingPct,
    base_metric_value: Math.round(baseMetricValue * 100) / 100,
    bars,
  };
}
