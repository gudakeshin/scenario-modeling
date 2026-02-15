/**
 * Monte Carlo Simulation Engine
 *
 * Runs N iterations of the financial model with probabilistic distributions
 * applied to scenario parameters. Produces P10/P50/P90 confidence intervals
 * and per-metric distribution data for fan charts and histograms.
 */

import { pool } from "../db/index.js";
import { getModelDefinition, getPLMetrics, getPercentDeltaVars, type ModelVariable } from "../models/registry.js";

// ── Distribution types ──

export type DistributionType = "normal" | "triangular" | "uniform";

export interface DistributionConfig {
  variable_id: string;
  type: DistributionType;
  /** For normal: mean; for triangular: mode; for uniform: ignored (uses min/max) */
  base_value: number;
  /** Standard deviation (normal), or spread factor. For triangular/uniform: min bound */
  min?: number;
  /** For triangular/uniform: max bound */
  max?: number;
  /** For normal: stddev. Default = 10% of base_value */
  stddev?: number;
}

export interface MonteCarloConfig {
  scenario_id: string;
  iterations: number;
  distributions: DistributionConfig[];
}

export interface PercentileResult {
  p10: number;
  p50: number;
  p90: number;
  mean: number;
  stddev: number;
  min: number;
  max: number;
}

export interface MonteCarloResult {
  iterations: number;
  metrics: Record<string, PercentileResult>;
  /** Raw distribution data: metric → array of iteration values (for histograms) */
  distributions: Record<string, number[]>;
  /** Fan chart data: sorted percentile bands per metric */
  fan_chart: Record<string, { p10: number; p25: number; p50: number; p75: number; p90: number }>;
}

// ── RNG helpers ──

/** Box-Muller transform for normal distribution */
function normalRandom(mean: number, stddev: number): number {
  const u1 = Math.random();
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mean + z * stddev;
}

function triangularRandom(min: number, mode: number, max: number): number {
  const u = Math.random();
  const fc = (mode - min) / (max - min);
  if (u < fc) {
    return min + Math.sqrt(u * (max - min) * (mode - min));
  }
  return max - Math.sqrt((1 - u) * (max - min) * (max - mode));
}

function uniformRandom(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function sampleDistribution(config: DistributionConfig): number {
  switch (config.type) {
    case "normal": {
      const sd = config.stddev ?? (Math.abs(config.base_value * 0.1) || 1);
      return normalRandom(config.base_value, sd);
    }
    case "triangular": {
      const min = config.min ?? config.base_value * 0.8;
      const max = config.max ?? config.base_value * 1.2;
      return triangularRandom(min, config.base_value, max);
    }
    case "uniform": {
      const min = config.min ?? config.base_value * 0.8;
      const max = config.max ?? config.base_value * 1.2;
      return uniformRandom(min, max);
    }
    default:
      return config.base_value;
  }
}

// ── Topological sort & formula eval (duplicated for isolation) ──

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

function percentile(sorted: number[], p: number): number {
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function stddev(arr: number[], mean: number): number {
  const sumSq = arr.reduce((s, v) => s + (v - mean) ** 2, 0);
  return Math.sqrt(sumSq / arr.length);
}

// ── Main engine ──

// PL_METRICS and PERCENT_DELTA_VARS are now derived dynamically inside runMonteCarlo

export async function runMonteCarlo(config: MonteCarloConfig): Promise<MonteCarloResult> {
  const iterations = Math.min(Math.max(config.iterations || 1000, 100), 10000);

  // Load model
  const scenarioRes = await pool.query("SELECT model_version_hash FROM scenarios WHERE scenario_id = $1", [config.scenario_id]);
  if (scenarioRes.rows.length === 0) throw new Error("Scenario not found");
  const model = await getModelDefinition(scenarioRes.rows[0].model_version_hash);
  const order = topologicalSort(model.variables);

  // Derive from model — not hardcoded
  const PL_METRICS = getPLMetrics(model);
  const PERCENT_DELTA_VARS = getPercentDeltaVars(model);

  // Load scenario overrides (deterministic)
  const paramsRes = await pool.query(
    "SELECT mapped_variable_id, scenario_value, status FROM scenario_parameters WHERE scenario_id = $1 AND status IN ('pending','accepted','modified')",
    [config.scenario_id]
  );
  const deterministicOverrides = new Map<string, number>();
  for (const row of paramsRes.rows) {
    deterministicOverrides.set(row.mapped_variable_id, Number(row.scenario_value));
  }

  // Build distribution lookup
  const distMap = new Map<string, DistributionConfig>();
  for (const d of config.distributions) {
    distMap.set(d.variable_id, d);
  }

  // Compute base context once
  const baseCtx: Record<string, number> = {};
  for (const id of order) {
    const v = model.variables.find((x) => x.id === id);
    if (!v) continue;
    baseCtx[id] = evaluateFormula(v.formula, baseCtx);
  }

  // Run iterations
  const results: Record<string, number[]> = {};
  for (const m of PL_METRICS) results[m] = [];

  for (let i = 0; i < iterations; i++) {
    const ctx: Record<string, number> = { ...baseCtx };

    // Apply deterministic overrides first
    for (const [id, val] of deterministicOverrides) {
      if (PERCENT_DELTA_VARS.has(id) && val >= 0 && val <= 100 && baseCtx[id] != null) {
        ctx[id] = baseCtx[id] * (1 + val / 100);
      } else {
        ctx[id] = val;
      }
    }

    // Apply stochastic perturbation from distributions
    for (const [varId, dist] of distMap) {
      const sampled = sampleDistribution(dist);
      if (PERCENT_DELTA_VARS.has(varId) && baseCtx[varId] != null) {
        // treat sampled value as percentage delta
        ctx[varId] = baseCtx[varId] * (1 + sampled / 100);
      } else {
        ctx[varId] = sampled;
      }
    }

    // Re-evaluate dependent variables
    for (const id of order) {
      if (deterministicOverrides.has(id) || distMap.has(id)) continue;
      const v = model.variables.find((x) => x.id === id);
      if (!v) continue;
      ctx[id] = evaluateFormula(v.formula, ctx);
    }

    for (const m of PL_METRICS) {
      results[m].push(Math.round((ctx[m] ?? 0) * 100) / 100);
    }
  }

  // Compute statistics
  const metrics: Record<string, PercentileResult> = {};
  const fan_chart: Record<string, { p10: number; p25: number; p50: number; p75: number; p90: number }> = {};

  for (const m of PL_METRICS) {
    const arr = results[m].sort((a, b) => a - b);
    const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
    metrics[m] = {
      p10: Math.round(percentile(arr, 10) * 100) / 100,
      p50: Math.round(percentile(arr, 50) * 100) / 100,
      p90: Math.round(percentile(arr, 90) * 100) / 100,
      mean: Math.round(mean * 100) / 100,
      stddev: Math.round(stddev(arr, mean) * 100) / 100,
      min: arr[0],
      max: arr[arr.length - 1],
    };
    fan_chart[m] = {
      p10: metrics[m].p10,
      p25: Math.round(percentile(arr, 25) * 100) / 100,
      p50: metrics[m].p50,
      p75: Math.round(percentile(arr, 75) * 100) / 100,
      p90: metrics[m].p90,
    };
  }

  // Store result
  await pool.query(
    `INSERT INTO scenario_outputs (scenario_id, output_type, output_data) VALUES ($1, 'monte_carlo', $2)`,
    [config.scenario_id, JSON.stringify({ iterations, metrics, fan_chart })]
  );

  // Return truncated distributions (max 200 bins for histogram)
  const truncatedDist: Record<string, number[]> = {};
  for (const m of PL_METRICS) {
    if (results[m].length > 200) {
      const step = Math.floor(results[m].length / 200);
      truncatedDist[m] = results[m].filter((_, idx) => idx % step === 0);
    } else {
      truncatedDist[m] = results[m];
    }
  }

  return { iterations, metrics, distributions: truncatedDist, fan_chart };
}
