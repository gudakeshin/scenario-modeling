/**
 * Monte Carlo Simulation Engine
 *
 * Runs N iterations of the financial model (formula DAG or XLSX cell graph)
 * with probabilistic distributions applied to scenario inputs.
 *
 * Statistical properties:
 *  - Seeded PRNG (mulberry32) — every run is reproducible; the seed is
 *    persisted with the result and can be passed back in to replay.
 *  - Distributions: normal, lognormal, triangular, uniform, PERT.
 *  - Optional pairwise correlations via Gaussian copula (Cholesky).
 *  - Sample standard deviation (n-1), percentiles p5–p95, VaR/CVaR at 5%,
 *    probability of negative outcome, and a 95% CI on the mean.
 */

import { pool } from "../db/index.js";
import { monteCarloIterations } from "../metrics.js";
import {
  getEvaluableModelForScenario,
  loadScenarioOverrides,
  resolveOverridesToAbsolute,
  toDimensionalOverrides,
} from "./modelResolver.js";
import type { DeltaType, EvaluableModel, ModelInput } from "./expression.js";
import type { DimensionalOverride } from "../models/dimensions.js";
import { DimensionalModel } from "./dimensionalModel.js";
import {
  mulberry32,
  randomSeed,
  normal01,
  normalCdf,
  lognormalRandom,
  triangularRandom,
  uniformRandom,
  pertRandom,
  cholesky,
  type Rng,
} from "./random.js";
import type { MetricType } from "./metricTypes.js";

// ── Distribution types ──

export type DistributionType = "normal" | "lognormal" | "triangular" | "uniform" | "pert";

export interface DistributionConfig {
  variable_id: string;
  type: DistributionType;
  /** Center of the distribution: mean (normal/lognormal) or mode (triangular/PERT). */
  base_value: number;
  /** Lower bound for triangular/uniform/PERT. Default: base * 0.8. */
  min?: number;
  /** Upper bound for triangular/uniform/PERT. Default: base * 1.2. */
  max?: number;
  /** Stddev for normal/lognormal. Default: 10% of |base|. */
  stddev?: number;
  /**
   * How the sampled value is applied to the model input:
   *  - "percent": sampled value is a % delta on the input's base value
   *  - "absolute": sampled value IS the input value
   * Default "percent" (matches scenario parameters, which are deltas).
   */
  delta_type?: DeltaType;
  /** Clamp absolute sampled values at 0 for currency/volume/count inputs. */
  truncate_at_zero?: boolean;
}

export interface CorrelationSpec {
  a: string;
  b: string;
  rho: number;
}

export interface MonteCarloConfig {
  scenario_id: string;
  iterations: number;
  distributions: DistributionConfig[];
  correlations?: CorrelationSpec[];
  /** Reproducibility: pass a previous run's seed to replay it exactly. */
  seed?: number;
}

export interface PercentileResult {
  p5: number;
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  p95: number;
  mean: number;
  /** Sample standard deviation (n-1). */
  stddev: number;
  min: number;
  max: number;
  /** Value at Risk at 5% (the p5 outcome). */
  var_5: number;
  /** Conditional VaR: mean of outcomes at or below p5. */
  cvar_5: number;
  /** Probability the metric is negative. */
  prob_negative: number;
  /** 95% confidence interval on the mean. */
  mean_ci_95: [number, number];
}

export interface MonteCarloResult {
  iterations: number;
  requested_iterations: number;
  seed: number;
  metrics: Record<string, PercentileResult>;
  /** Raw distribution data: metric → array of iteration values (for histograms) */
  distributions: Record<string, number[]>;
  /** Percentile bands per metric */
  fan_chart: Record<string, { p5: number; p10: number; p25: number; p50: number; p75: number; p90: number; p95: number }>;
  correlations_applied: boolean;
  notices?: string[];
}

// ── Sampling ──

const COPULA_SUPPORTED: ReadonlySet<DistributionType> = new Set([
  "normal",
  "lognormal",
  "triangular",
  "uniform",
]);

function defaultStddev(base: number): number {
  return Math.abs(base * 0.1) || 1;
}

function defaultBounds(config: DistributionConfig): { min: number; max: number } {
  const lo = config.min ?? Math.min(config.base_value * 0.8, config.base_value * 1.2);
  const hi = config.max ?? Math.max(config.base_value * 0.8, config.base_value * 1.2);
  return { min: lo, max: hi };
}

/** Sample independently (no copula). */
function sampleDistribution(rng: Rng, config: DistributionConfig): number {
  switch (config.type) {
    case "normal":
      return config.base_value + normal01(rng) * (config.stddev ?? defaultStddev(config.base_value));
    case "lognormal":
      return lognormalRandom(rng, config.base_value, config.stddev ?? defaultStddev(config.base_value));
    case "triangular": {
      const { min, max } = defaultBounds(config);
      return triangularRandom(rng, min, config.base_value, max);
    }
    case "uniform": {
      const { min, max } = defaultBounds(config);
      return uniformRandom(rng, min, max);
    }
    case "pert": {
      const { min, max } = defaultBounds(config);
      return pertRandom(rng, min, config.base_value, max);
    }
    default:
      return config.base_value;
  }
}

/** Transform a standard normal draw into the target distribution (Gaussian copula). */
function transformNormalDraw(z: number, config: DistributionConfig): number {
  switch (config.type) {
    case "normal":
      return config.base_value + z * (config.stddev ?? defaultStddev(config.base_value));
    case "lognormal": {
      const mean = config.base_value;
      const sd = config.stddev ?? defaultStddev(mean);
      const variance = sd * sd;
      const mu = Math.log(mean * mean / Math.sqrt(variance + mean * mean));
      const sigma = Math.sqrt(Math.log(1 + variance / (mean * mean)));
      return Math.exp(mu + sigma * z);
    }
    case "uniform": {
      const { min, max } = defaultBounds(config);
      return min + normalCdf(z) * (max - min);
    }
    case "triangular": {
      const { min, max } = defaultBounds(config);
      const mode = config.base_value;
      const u = normalCdf(z);
      const fc = (mode - min) / (max - min);
      if (u < fc) return min + Math.sqrt(u * (max - min) * (mode - min));
      return max - Math.sqrt((1 - u) * (max - min) * (max - mode));
    }
    default:
      return config.base_value;
  }
}

// ── Statistics ──

function percentile(sorted: number[], p: number): number {
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function sampleStddev(arr: number[], mean: number): number {
  if (arr.length < 2) return 0;
  const sumSq = arr.reduce((s, v) => s + (v - mean) ** 2, 0);
  return Math.sqrt(sumSq / (arr.length - 1));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ── Main engine ──

export const MC_MIN_ITERATIONS = 100;
export const MC_MAX_ITERATIONS = 20_000;
export const MC_DEFAULT_ITERATIONS = 10_000;
const MC_TIME_BUDGET_MS = Number(process.env.MC_TIME_BUDGET_MS) || 30_000;

class McConfigError extends Error {
  status = 422;
}

export async function runMonteCarlo(config: MonteCarloConfig): Promise<MonteCarloResult> {
  const requestedIterations = Math.min(
    Math.max(config.iterations || MC_DEFAULT_ITERATIONS, MC_MIN_ITERATIONS),
    MC_MAX_ITERATIONS,
  );
  const seed = config.seed != null && Number.isFinite(config.seed) ? config.seed >>> 0 : randomSeed();
  const rng = mulberry32(seed);
  const notices: string[] = [];

  const resolved = await getEvaluableModelForScenario(config.scenario_id);
  const model: EvaluableModel = resolved.model;
  const outputIds = model.outputIds;
  if (outputIds.length === 0) throw new McConfigError("Model has no output metrics to simulate");

  // Deterministic scenario overrides applied to every iteration
  const overrides = await loadScenarioOverrides(config.scenario_id);
  const { absolute: deterministicAbs } = resolveOverridesToAbsolute(model, overrides);
  const dimensional = resolved.source === "external_model" && model instanceof DimensionalModel;
  const scenarioScopeByVariable = new Map(
    overrides.map((override) => [override.variableId, override.memberScope ?? undefined]),
  );

  const inputBaseById = new Map(model.inputs.map((i) => [i.id, i.base]));
  const inputById = new Map(model.inputs.map((i) => [i.id, i]));

  // Auto-generate distributions from scenario parameters when none provided
  let dists = config.distributions.filter((d) => d && d.variable_id);
  if (dists.length === 0) {
    dists = await autoGenerateDistributions(config.scenario_id, model);
  }

  // Validate distributions
  for (const d of dists) {
    if (!Number.isFinite(d.base_value)) {
      throw new McConfigError(`Distribution for '${d.variable_id}' has a non-numeric base_value`);
    }
    if (d.type === "lognormal" && d.base_value <= 0) {
      throw new McConfigError(`Lognormal distribution for '${d.variable_id}' requires a positive base_value`);
    }
  }

  const clampCounts = new Map<string, number>();

  // ── Correlation setup (Gaussian copula) ──
  let correlated: { order: string[]; L: number[][] } | null = null;
  const correlations = (config.correlations || []).filter((c) => c && c.a && c.b);
  if (correlations.length > 0) {
    const distById = new Map(dists.map((d) => [d.variable_id, d]));
    const corrVars = [...new Set(correlations.flatMap((c) => [c.a, c.b]))];
    for (const v of corrVars) {
      const d = distById.get(v);
      if (!d) throw new McConfigError(`Correlation references '${v}' which has no distribution`);
      if (!COPULA_SUPPORTED.has(d.type)) {
        throw new McConfigError(
          `Correlated sampling is not supported for '${d.type}' distributions (variable '${v}'). ` +
            "Use normal, lognormal, triangular, or uniform for correlated variables.",
        );
      }
    }
    for (const c of correlations) {
      if (!Number.isFinite(c.rho) || c.rho < -1 || c.rho > 1) {
        throw new McConfigError(`Correlation between '${c.a}' and '${c.b}' must be in [-1, 1]`);
      }
    }
    const n = corrVars.length;
    const matrix: number[][] = Array.from({ length: n }, (_, i) =>
      Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
    );
    const idx = new Map(corrVars.map((v, i) => [v, i]));
    for (const c of correlations) {
      const i = idx.get(c.a)!;
      const j = idx.get(c.b)!;
      matrix[i][j] = c.rho;
      matrix[j][i] = c.rho;
    }
    let L: number[][];
    try {
      L = cholesky(matrix);
    } catch (e) {
      throw new McConfigError((e as Error).message);
    }
    correlated = { order: corrVars, L };
  }

  // ── Iterations ──
  const results: Record<string, number[]> = {};
  for (const m of outputIds) results[m] = [];

  const startedAt = Date.now();
  let completed = 0;
  const correlatedSet = new Set(correlated?.order ?? []);
  const sampledVariableIds = new Set(dists.map((dist) => dist.variable_id));
  const baseDimensionalOverrides = dimensional
    ? toDimensionalOverrides(overrides).filter(
        (override) => !sampledVariableIds.has(override.variableId),
      )
    : [];

  monteCarloIterations.inc(requestedIterations);
  for (let i = 0; i < requestedIterations; i++) {
    const absVals: Record<string, number> = { ...deterministicAbs };
    const sampledDimensionalOverrides: DimensionalOverride[] = [];

    // Correlated block first (consumes one normal draw per correlated var)
    if (correlated) {
      const { order, L } = correlated;
      const z = order.map(() => normal01(rng));
      for (let r = 0; r < order.length; r++) {
        let zc = 0;
        for (let k = 0; k <= r; k++) zc += L[r][k] * z[k];
        const dist = dists.find((d) => d.variable_id === order[r])!;
        const sampled = transformNormalDraw(zc, dist);
        if (dimensional) {
          applySampledDimensional(
            sampledDimensionalOverrides,
            dist,
            sampled,
            scenarioScopeByVariable.get(dist.variable_id),
            inputById,
            clampCounts,
          );
        } else {
          applySampled(absVals, dist, sampled, inputBaseById, notices, inputById, clampCounts);
        }
      }
    }

    // Independent distributions
    for (const dist of dists) {
      if (correlatedSet.has(dist.variable_id)) continue;
      const sampled = sampleDistribution(rng, dist);
      if (dimensional) {
        applySampledDimensional(
          sampledDimensionalOverrides,
          dist,
          sampled,
          scenarioScopeByVariable.get(dist.variable_id),
          inputById,
          clampCounts,
        );
      } else {
        applySampled(absVals, dist, sampled, inputBaseById, notices, inputById, clampCounts);
      }
    }

    const out = dimensional
      ? model.evaluateDimensional([
          ...baseDimensionalOverrides,
          ...sampledDimensionalOverrides,
        ]).totals
      : model.evaluate(absVals);
    for (const m of outputIds) {
      results[m].push(round2(out[m] ?? 0));
    }
    completed++;

    // Soft time budget so huge XLSX models degrade gracefully
    if ((i & 0x1ff) === 0x1ff && Date.now() - startedAt > MC_TIME_BUDGET_MS) {
      notices.push(
        `Stopped after ${completed} of ${requestedIterations} iterations (time budget ${MC_TIME_BUDGET_MS / 1000}s). ` +
          "Results are statistically valid for the completed sample size.",
      );
      break;
    }
  }

  for (const [varId, clamps] of clampCounts) {
    if (completed > 0 && clamps / completed > 0.05) {
      notices.push(
        `Clamped negative draws for '${varId}' in ${((clamps / completed) * 100).toFixed(0)}% of iterations — ` +
          `consider a lognormal distribution for this input.`,
      );
    }
  }

  // ── Statistics ──
  const metrics: Record<string, PercentileResult> = {};
  const fan_chart: MonteCarloResult["fan_chart"] = {};

  for (const m of outputIds) {
    const arr = results[m].slice().sort((a, b) => a - b);
    const n = arr.length;
    const mean = arr.reduce((s, v) => s + v, 0) / n;
    const sd = sampleStddev(arr, mean);
    const p5 = percentile(arr, 5);
    const tail = arr.filter((v) => v <= p5);
    const cvar = tail.length > 0 ? tail.reduce((s, v) => s + v, 0) / tail.length : p5;
    const ciHalf = 1.96 * (sd / Math.sqrt(n));

    metrics[m] = {
      p5: round2(p5),
      p10: round2(percentile(arr, 10)),
      p25: round2(percentile(arr, 25)),
      p50: round2(percentile(arr, 50)),
      p75: round2(percentile(arr, 75)),
      p90: round2(percentile(arr, 90)),
      p95: round2(percentile(arr, 95)),
      mean: round2(mean),
      stddev: round2(sd),
      min: arr[0],
      max: arr[n - 1],
      var_5: round2(p5),
      cvar_5: round2(cvar),
      prob_negative: round2(arr.filter((v) => v < 0).length / n),
      mean_ci_95: [round2(mean - ciHalf), round2(mean + ciHalf)],
    };
    fan_chart[m] = {
      p5: metrics[m].p5,
      p10: metrics[m].p10,
      p25: metrics[m].p25,
      p50: metrics[m].p50,
      p75: metrics[m].p75,
      p90: metrics[m].p90,
      p95: metrics[m].p95,
    };
  }

  const dedupedNotices = [...new Set(notices)];

  // Store result (seed included for reproducibility / audit)
  await pool.query(
    `INSERT INTO scenario_outputs (scenario_id, output_type, output_data) VALUES ($1, 'monte_carlo', $2)`,
    [
      config.scenario_id,
      JSON.stringify({
        iterations: completed,
        requested_iterations: requestedIterations,
        seed,
        metrics,
        fan_chart,
        correlations_applied: !!correlated,
        ...(dedupedNotices.length > 0 ? { notices: dedupedNotices } : {}),
      }),
    ],
  );

  // Return truncated distributions (max 200 samples per metric for histograms)
  const truncatedDist: Record<string, number[]> = {};
  for (const m of outputIds) {
    if (results[m].length > 200) {
      const step = Math.floor(results[m].length / 200);
      truncatedDist[m] = results[m].filter((_, idx) => idx % step === 0);
    } else {
      truncatedDist[m] = results[m];
    }
  }

  return {
    iterations: completed,
    requested_iterations: requestedIterations,
    seed,
    metrics,
    distributions: truncatedDist,
    fan_chart,
    correlations_applied: !!correlated,
    ...(dedupedNotices.length > 0 ? { notices: dedupedNotices } : {}),
  };
}

/** Apply one sampled value to the absolute input map, honoring delta semantics. */
export function applySampled(
  absVals: Record<string, number>,
  dist: DistributionConfig,
  sampled: number,
  inputBaseById: Map<string, number>,
  notices: string[],
  inputById?: Map<string, ModelInput>,
  clampCounts?: Map<string, number>,
): void {
  const deltaType: DeltaType = dist.delta_type ?? "percent";
  let absolute: number;
  if (deltaType === "percent") {
    const base = inputBaseById.get(dist.variable_id);
    if (base == null || base === 0) {
      notices.push(
        `Distribution for '${dist.variable_id}' was skipped — percent deltas need a non-zero model base value.`,
      );
      return;
    }
    absolute = base * (1 + sampled / 100);
  } else {
    absolute = sampled;
  }

  const mt: MetricType | undefined = inputById?.get(dist.variable_id)?.metricType;
  const shouldTruncate =
    dist.truncate_at_zero === true ||
    (dist.truncate_at_zero !== false &&
      deltaType === "absolute" &&
      (mt === "currency" || mt === "volume" || mt === "count"));

  if (shouldTruncate && absolute < 0) {
    absolute = 0;
    if (clampCounts) {
      clampCounts.set(dist.variable_id, (clampCounts.get(dist.variable_id) ?? 0) + 1);
    }
  }

  absVals[dist.variable_id] = absolute;
}

function applySampledDimensional(
  overrides: DimensionalOverride[],
  dist: DistributionConfig,
  sampled: number,
  memberScope: Record<string, string> | undefined,
  inputById?: Map<string, ModelInput>,
  clampCounts?: Map<string, number>,
): void {
  const deltaType: DeltaType = dist.delta_type ?? "percent";
  let value = sampled;
  const mt = inputById?.get(dist.variable_id)?.metricType;
  const shouldTruncate =
    dist.truncate_at_zero === true ||
    (dist.truncate_at_zero !== false &&
      deltaType === "absolute" &&
      (mt === "currency" || mt === "volume" || mt === "count"));
  if (shouldTruncate && value < 0) {
    value = 0;
    clampCounts?.set(dist.variable_id, (clampCounts.get(dist.variable_id) ?? 0) + 1);
  }
  overrides.push({
    variableId: dist.variable_id,
    value,
    delta_type: deltaType,
    ...(memberScope ? { memberScope } : {}),
  });
}

/**
 * Auto-generate MC distributions from scenario parameters.
 * Percent deltas: stddev = 5pp. Absolute: stddev = 10% of model input base;
 * lognormal for positive-base currency/volume.
 */
export function buildAutoDistributions(
  params: Array<{ mapped_variable_id: string; scenario_value: number; delta_type: string }>,
  model: EvaluableModel,
): DistributionConfig[] {
  const inputById = new Map(model.inputs.map((i) => [i.id, i]));
  const dists: DistributionConfig[] = [];

  for (const row of params) {
    const deltaType: DeltaType = row.delta_type === "percent" ? "percent" : "absolute";
    const delta = Number(row.scenario_value);
    const input = inputById.get(row.mapped_variable_id);
    const mt = input?.metricType;
    const modelBase = input?.base ?? 0;

    if (deltaType === "percent") {
      dists.push({
        variable_id: row.mapped_variable_id,
        type: "normal",
        base_value: delta,
        stddev: 5,
        delta_type: "percent",
      });
      continue;
    }

    // Absolute: center on the absolute input value (scenario param is absolute)
    let baseValue = Number.isFinite(delta) ? delta : modelBase;
    const positiveFlow =
      baseValue > 0 && (mt === "currency" || mt === "volume" || mt === "unknown" || mt == null);
    let type: DistributionType = positiveFlow ? "lognormal" : "normal";
    if (type === "lognormal" && baseValue <= 0) {
      type = "normal";
      baseValue = Math.max(modelBase, Math.abs(delta), 1);
    }
    const stddev = Math.max(Math.abs(type === "lognormal" ? baseValue : modelBase) * 0.10, 1e-6);

    dists.push({
      variable_id: row.mapped_variable_id,
      type,
      base_value: baseValue,
      stddev,
      delta_type: "absolute",
      truncate_at_zero: mt === "currency" || mt === "volume" || mt === "count",
    });
  }
  return dists;
}

async function autoGenerateDistributions(
  scenarioId: string,
  model: EvaluableModel,
): Promise<DistributionConfig[]> {
  const pRes = await pool.query(
    "SELECT mapped_variable_id, scenario_value, delta_type FROM scenario_parameters WHERE scenario_id = $1 AND status IN ('pending','accepted','modified')",
    [scenarioId],
  );
  return buildAutoDistributions(
    pRes.rows.map((r: { mapped_variable_id: string; scenario_value: number; delta_type: string }) => ({
      mapped_variable_id: r.mapped_variable_id,
      scenario_value: Number(r.scenario_value),
      delta_type: r.delta_type,
    })),
    model,
  );
}

