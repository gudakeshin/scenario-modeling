/**
 * Driver attribution via Shapley values.
 *
 * Exact Shapley for ≤8 changed levers; deterministic sampled Shapley above that.
 * Contributions plus a residual bar always sum to the total metric delta.
 */

import { pool } from "../db/index.js";
import type { EvaluableModel } from "./expression.js";
import {
  getEvaluableModelForScenario,
  loadScenarioOverrides,
  resolveOverridesToAbsolute,
} from "./modelResolver.js";
import { mulberry32 } from "./random.js";
import { pickDefaultTargetMetric } from "./metricTypes.js";

export interface AttributionBar {
  variable_id: string;
  variable_name: string;
  contribution: number;
  /** True for the residual balancing bar. */
  residual?: boolean;
  rationale?: string;
}

export interface AttributionResult {
  target_metric: string;
  base_value: number;
  scenario_value: number;
  total_delta: number;
  method: "exact_shapley" | "sampled_shapley";
  bars: AttributionBar[];
  notices?: string[];
  driver_groups?: Array<{ category: string; variable_ids: string[]; rationale?: string }>;
  rationale?: string;
}

class AttributionError extends Error {
  status = 422;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function metricAt(
  model: EvaluableModel,
  abs: Record<string, number>,
  metric: string,
): number {
  const out = model.evaluate(abs);
  if (!(metric in out)) {
    throw new AttributionError(
      `Unknown target metric '${metric}'. Available: ${model.outputIds.join(", ")}`,
    );
  }
  return out[metric] ?? 0;
}

/** Exact Shapley: average marginal contribution over all 2^n coalitions. */
function exactShapley(
  model: EvaluableModel,
  baseAbs: Record<string, number>,
  scenarioAbs: Record<string, number>,
  leverIds: string[],
  metric: string,
): Record<string, number> {
  const n = leverIds.length;
  const contrib: Record<string, number> = Object.fromEntries(leverIds.map((id) => [id, 0]));
  const totalCoalitions = 1 << n;

  for (let mask = 0; mask < totalCoalitions; mask++) {
    const without: Record<string, number> = { ...baseAbs };
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) without[leverIds[i]] = scenarioAbs[leverIds[i]];
    }
    const vWithout = metricAt(model, without, metric);

    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) continue;
      const withI = { ...without, [leverIds[i]]: scenarioAbs[leverIds[i]] };
      const vWith = metricAt(model, withI, metric);
      const subsetSize = popcount(mask);
      // Weight = |S|!(n-|S|-1)! / n!
      const weight = factorial(subsetSize) * factorial(n - subsetSize - 1) / factorial(n);
      contrib[leverIds[i]] += weight * (vWith - vWithout);
    }
  }
  return contrib;
}

/** Deterministic sampled Shapley via seeded random permutations. */
function sampledShapley(
  model: EvaluableModel,
  baseAbs: Record<string, number>,
  scenarioAbs: Record<string, number>,
  leverIds: string[],
  metric: string,
  samples = 2000,
  seed = 0xA77B07E,
): Record<string, number> {
  const n = leverIds.length;
  const contrib: Record<string, number> = Object.fromEntries(leverIds.map((id) => [id, 0]));
  const rng = mulberry32(seed);

  for (let s = 0; s < samples; s++) {
    const order = [...leverIds];
    // Fisher–Yates with seeded RNG
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    const current: Record<string, number> = { ...baseAbs };
    let prev = metricAt(model, current, metric);
    for (const id of order) {
      current[id] = scenarioAbs[id];
      const next = metricAt(model, current, metric);
      contrib[id] += next - prev;
      prev = next;
    }
  }
  for (const id of leverIds) contrib[id] /= samples;
  return contrib;
}

function popcount(x: number): number {
  let c = 0;
  while (x) {
    c += x & 1;
    x >>>= 1;
  }
  return c;
}

const FACT_CACHE = [1];
function factorial(n: number): number {
  while (FACT_CACHE.length <= n) {
    FACT_CACHE.push(FACT_CACHE[FACT_CACHE.length - 1] * FACT_CACHE.length);
  }
  return FACT_CACHE[n];
}

/**
 * Pure attribution — no Postgres. Exported for unit tests.
 */
export function computeAttribution(
  model: EvaluableModel,
  baseAbs: Record<string, number>,
  scenarioAbs: Record<string, number>,
  targetMetric = "net_income",
): Omit<AttributionResult, "notices"> {
  targetMetric = pickDefaultTargetMetric(model.outputIds, targetMetric);
  const changed = model.inputs
    .map((i) => i.id)
    .filter((id) => {
      const base = baseAbs[id] ?? model.inputs.find((i) => i.id === id)?.base ?? 0;
      const scen = scenarioAbs[id] ?? base;
      return Number.isFinite(scen) && Math.abs(scen - base) > 1e-9;
    });

  const baseValue = metricAt(model, baseAbs, targetMetric);
  const scenarioValue = metricAt(model, scenarioAbs, targetMetric);
  const totalDelta = scenarioValue - baseValue;

  if (changed.length === 0) {
    return {
      target_metric: targetMetric,
      base_value: round2(baseValue),
      scenario_value: round2(scenarioValue),
      total_delta: round2(totalDelta),
      method: "exact_shapley",
      bars: [
        {
          variable_id: "_residual",
          variable_name: "Residual",
          contribution: round2(totalDelta),
          residual: true,
        },
      ],
    };
  }

  const fullBase: Record<string, number> = {};
  for (const input of model.inputs) {
    fullBase[input.id] = baseAbs[input.id] ?? input.base;
  }

  const method = changed.length <= 8 ? "exact_shapley" : "sampled_shapley";
  const raw =
    method === "exact_shapley"
      ? exactShapley(model, fullBase, scenarioAbs, changed, targetMetric)
      : sampledShapley(model, fullBase, scenarioAbs, changed, targetMetric);

  const bars: AttributionBar[] = [];
  let sumContrib = 0;
  for (const id of changed) {
    const contribution = round2(raw[id] ?? 0);
    sumContrib += contribution;
    const name = model.inputs.find((i) => i.id === id)?.name ?? id;
    bars.push({ variable_id: id, variable_name: name, contribution });
  }
  bars.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));

  const residual = round2(totalDelta - sumContrib);
  bars.push({
    variable_id: "_residual",
    variable_name: "Residual",
    contribution: residual,
    residual: true,
  });

  return {
    target_metric: targetMetric,
    base_value: round2(baseValue),
    scenario_value: round2(scenarioValue),
    total_delta: round2(totalDelta),
    method,
    bars,
  };
}

export async function runAttribution(
  scenarioId: string,
  targetMetric = "net_income",
  opts?: { reason?: boolean },
): Promise<AttributionResult> {
  const resolved = await getEvaluableModelForScenario(scenarioId);
  const model = resolved.model;
  const overrides = await loadScenarioOverrides(scenarioId);
  const { absolute: scenarioAbs, unresolved } = resolveOverridesToAbsolute(model, overrides);

  const baseAbs: Record<string, number> = {};
  for (const input of model.inputs) baseAbs[input.id] = input.base;

  const computed = computeAttribution(model, baseAbs, { ...baseAbs, ...scenarioAbs }, targetMetric);
  const notices: string[] = [];
  if (unresolved.length > 0) {
    notices.push(
      `Percent overrides for ${unresolved.join(", ")} could not be applied (no non-zero base value).`,
    );
  }

  let result: AttributionResult = {
    ...computed,
    ...(notices.length > 0 ? { notices } : {}),
  };

  if (opts?.reason) {
    const { reasonAttribution } = await import("./driverReasoningAgent.js");
    result = await reasonAttribution(result);
  }

  await pool.query(
    `INSERT INTO scenario_outputs (scenario_id, output_type, output_data) VALUES ($1, 'attribution', $2)`,
    [scenarioId, JSON.stringify(result)],
  );

  return result;
}
