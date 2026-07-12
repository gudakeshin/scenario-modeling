/**
 * Sensitivity Analysis / Tornado Chart Service
 *
 * One-at-a-time perturbation: each input is swung around its value in
 * the SCENARIO being analyzed (base + scenario parameter overrides).
 *
 * Percent inputs swing in percentage points; ratio inputs use absolute
 * swings; currency/count/volume use relative ±swing%.
 */

import { pool } from "../db/index.js";
import type { EvaluableModel } from "./expression.js";
import type { MetricType } from "./metricTypes.js";
import type { DimensionalOverride } from "../models/dimensions.js";
import { DimensionalModel } from "./dimensionalModel.js";
import {
  getEvaluableModelForScenario,
  loadScenarioOverrides,
  resolveOverridesToAbsolute,
  toDimensionalOverrides,
} from "./modelResolver.js";

export type SwingUnit = "pp" | "relative" | "absolute";

export interface TornadoBar {
  variable_id: string;
  variable_name: string;
  low_value: number;
  high_value: number;
  base_value: number;
  low_delta: number;
  high_delta: number;
  spread: number;
  /** True when the input's scenario value was 0 and an absolute step was used. */
  absolute_step?: boolean;
  swing_unit?: SwingUnit;
  step_size?: number;
}

export interface SensitivityResult {
  target_metric: string;
  swing_pct: number;
  percent_swing_pp?: number;
  base_metric_value: number;
  scenario_applied: boolean;
  bars: TornadoBar[];
  notices?: string[];
  /** Per-driver swing magnitudes used (from MC volatility when available). */
  swing_by_variable?: Record<string, number>;
}

export interface TwoWayGridResult {
  target_metric: string;
  variable_a: string;
  variable_b: string;
  variable_a_name: string;
  variable_b_name: string;
  base_metric_value: number;
  swings_a: number[];
  swings_b: number[];
  /** grid[i][j] = metric at swings_a[i], swings_b[j] (absolute input values used) */
  grid: number[][];
  values_a: number[];
  values_b: number[];
  notices?: string[];
}

export interface ComputeTornadoOpts {
  swingPct?: number;
  /** Percentage-point swing for percent-type inputs. Default: swingPct / 4. */
  percentSwingPp?: number;
  /**
   * Per-driver relative/absolute swing magnitudes (e.g. from MC fitted σ).
   * Interpreted as ±fraction of scenario value for currency, or absolute for ratio/percent.
   */
  swingByVariable?: Record<string, number>;
}

export interface ComputeTwoWayOpts {
  /** Relative swing magnitudes (e.g. [-0.2, -0.1, 0, 0.1, 0.2]). Default ±20% in 5 steps. */
  swings?: number[];
  /** Per-driver swing magnitudes keyed by variable id (overrides swings for that driver). */
  swingByVariable?: Record<string, number[]>;
  percentSwingPp?: number;
}

class SensitivityError extends Error {
  status = 422;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function inputMetricType(input: { id: string; metricType?: MetricType }): MetricType {
  return input.metricType ?? "unknown";
}

/**
 * Pure tornado computation — no Postgres. Exported for unit tests.
 */
export function computeTornado(
  model: EvaluableModel,
  scenarioAbs: Record<string, number>,
  targetMetric: string,
  opts: ComputeTornadoOpts = {},
): { bars: TornadoBar[]; base_metric_value: number; swing_pct: number; percent_swing_pp: number } {
  const swingPct = opts.swingPct ?? 20;
  const percentSwingPp = opts.percentSwingPp ?? swingPct / 4;
  const swing = swingPct / 100;
  const swingByVar = opts.swingByVariable;

  const scenarioCtx = model.evaluate(scenarioAbs);
  if (!(targetMetric in scenarioCtx)) {
    throw new SensitivityError(
      `Unknown target metric '${targetMetric}'. Available metrics: ${model.outputIds.join(", ")}`,
    );
  }
  const baseMetricValue = scenarioCtx[targetMetric] ?? 0;

  const bars: TornadoBar[] = [];

  for (const input of model.inputs) {
    const scenarioVal = scenarioAbs[input.id] ?? input.base;
    const mt = inputMetricType(input);
    const customSwing = swingByVar?.[input.id];

    let low: number;
    let high: number;
    let absoluteStep = false;
    let swingUnit: SwingUnit = "relative";
    let stepSize: number | undefined;

    if (scenarioVal === 0) {
      const step = customSwing != null && customSwing > 0
        ? customSwing
        : Math.max(Math.abs(baseMetricValue) * 0.01, 1);
      low = -step;
      high = step;
      absoluteStep = true;
      swingUnit = "absolute";
      stepSize = step;
    } else if (mt === "percent") {
      const pp = customSwing != null && customSwing > 0 ? customSwing : percentSwingPp;
      low = Math.max(0, scenarioVal - pp);
      high = scenarioVal + pp;
      swingUnit = "pp";
      stepSize = pp;
    } else if (mt === "ratio") {
      const absSwing = customSwing != null && customSwing > 0 ? customSwing : (swingPct / 100) * 1.0;
      low = scenarioVal - absSwing;
      high = scenarioVal + absSwing;
      swingUnit = "absolute";
      stepSize = absSwing;
    } else {
      const rel = customSwing != null && customSwing > 0 ? customSwing : swing;
      low = scenarioVal * (1 - rel);
      high = scenarioVal * (1 + rel);
      swingUnit = "relative";
      stepSize = rel;
    }

    const lowCtx = model.evaluate({ ...scenarioAbs, [input.id]: low });
    const highCtx = model.evaluate({ ...scenarioAbs, [input.id]: high });

    const lowMetric = round2(lowCtx[targetMetric] ?? 0);
    const highMetric = round2(highCtx[targetMetric] ?? 0);

    bars.push({
      variable_id: input.id,
      variable_name: input.name,
      low_value: lowMetric,
      high_value: highMetric,
      base_value: round2(baseMetricValue),
      low_delta: round2(lowMetric - baseMetricValue),
      high_delta: round2(highMetric - baseMetricValue),
      spread: round2(Math.abs(highMetric - lowMetric)),
      swing_unit: swingUnit,
      ...(absoluteStep ? { absolute_step: true } : {}),
      ...(stepSize != null ? { step_size: round2(stepSize) } : {}),
    });
  }

  bars.sort((a, b) => b.spread - a.spread);

  return {
    bars,
    base_metric_value: round2(baseMetricValue),
    swing_pct: swingPct,
    percent_swing_pp: percentSwingPp,
  };
}

export function computeTornadoDimensional(
  model: DimensionalModel,
  scenarioOverrides: DimensionalOverride[],
  targetMetric: string,
  opts: ComputeTornadoOpts = {},
): { bars: TornadoBar[]; base_metric_value: number; swing_pct: number; percent_swing_pp: number } {
  const swingPct = opts.swingPct ?? 20;
  const percentSwingPp = opts.percentSwingPp ?? swingPct / 4;
  const swing = swingPct / 100;
  const swingByVar = opts.swingByVariable;
  const scenarioResult = model.evaluateDimensional(scenarioOverrides);
  if (!(targetMetric in scenarioResult.totals)) {
    throw new SensitivityError(
      `Unknown target metric '${targetMetric}'. Available metrics: ${model.outputIds.join(", ")}`,
    );
  }
  const baseMetricValue = scenarioResult.totals[targetMetric] ?? 0;
  const bars: TornadoBar[] = [];

  for (const input of model.inputs) {
    const inputOverride = scenarioOverrides.find((override) => override.variableId === input.id);
    const memberScope = inputOverride?.memberScope;
    const scenarioVal =
      scenarioResult.valueAt(input.id, memberScope ?? {}) ??
      scenarioResult.totals[input.id] ??
      input.base;
    const mt = inputMetricType(input);
    const customSwing = swingByVar?.[input.id];
    let low: number;
    let high: number;
    let absoluteStep = false;
    let swingUnit: SwingUnit = "relative";
    let stepSize: number | undefined;

    if (scenarioVal === 0) {
      const step = customSwing != null && customSwing > 0
        ? customSwing
        : Math.max(Math.abs(baseMetricValue) * 0.01, 1);
      low = -step;
      high = step;
      absoluteStep = true;
      swingUnit = "absolute";
      stepSize = step;
    } else if (mt === "percent") {
      const pp = customSwing != null && customSwing > 0 ? customSwing : percentSwingPp;
      low = Math.max(0, scenarioVal - pp);
      high = scenarioVal + pp;
      swingUnit = "pp";
      stepSize = pp;
    } else if (mt === "ratio") {
      const absSwing = customSwing != null && customSwing > 0 ? customSwing : swingPct / 100;
      low = scenarioVal - absSwing;
      high = scenarioVal + absSwing;
      swingUnit = "absolute";
      stepSize = absSwing;
    } else {
      const rel = customSwing != null && customSwing > 0 ? customSwing : swing;
      low = scenarioVal * (1 - rel);
      high = scenarioVal * (1 + rel);
      swingUnit = "relative";
      stepSize = rel;
    }

    const withoutInput = scenarioOverrides.filter((override) => override.variableId !== input.id);
    const makeOverride = (value: number): DimensionalOverride => ({
      variableId: input.id,
      value,
      delta_type: "absolute",
      ...(memberScope ? { memberScope } : {}),
    });
    const lowCtx = model.evaluateDimensional([...withoutInput, makeOverride(low)]).totals;
    const highCtx = model.evaluateDimensional([...withoutInput, makeOverride(high)]).totals;
    const lowMetric = round2(lowCtx[targetMetric] ?? 0);
    const highMetric = round2(highCtx[targetMetric] ?? 0);

    bars.push({
      variable_id: input.id,
      variable_name: input.name,
      low_value: lowMetric,
      high_value: highMetric,
      base_value: round2(baseMetricValue),
      low_delta: round2(lowMetric - baseMetricValue),
      high_delta: round2(highMetric - baseMetricValue),
      spread: round2(Math.abs(highMetric - lowMetric)),
      swing_unit: swingUnit,
      ...(absoluteStep ? { absolute_step: true } : {}),
      ...(stepSize != null ? { step_size: round2(stepSize) } : {}),
    });
  }

  bars.sort((a, b) => b.spread - a.spread);
  return {
    bars,
    base_metric_value: round2(baseMetricValue),
    swing_pct: swingPct,
    percent_swing_pp: percentSwingPp,
  };
}

function resolveSwingValues(
  scenarioVal: number,
  mt: MetricType,
  swings: number[],
  percentSwingPp: number,
  baseMetricValue: number,
): number[] {
  if (scenarioVal === 0) {
    const step = Math.max(Math.abs(baseMetricValue) * 0.01, 1);
    return swings.map((s) => s * step * 5); // map relative swings onto absolute steps
  }
  if (mt === "percent") {
    return swings.map((s) => Math.max(0, scenarioVal + s * percentSwingPp * 5));
  }
  if (mt === "ratio") {
    return swings.map((s) => scenarioVal + s);
  }
  return swings.map((s) => scenarioVal * (1 + s));
}

/**
 * Two-way sensitivity grid — pure, no Postgres. Exported for unit tests.
 */
export function computeTwoWayGrid(
  model: EvaluableModel,
  scenarioAbs: Record<string, number>,
  metric: string,
  varA: string,
  varB: string,
  opts: ComputeTwoWayOpts = {},
): Omit<TwoWayGridResult, "notices"> {
  const swings = opts.swings ?? [-0.2, -0.1, 0, 0.1, 0.2];
  const swingsA = opts.swingByVariable?.[varA] ?? swings;
  const swingsB = opts.swingByVariable?.[varB] ?? swings;
  const percentSwingPp = opts.percentSwingPp ?? 5;

  const inputA = model.inputs.find((i) => i.id === varA);
  const inputB = model.inputs.find((i) => i.id === varB);
  if (!inputA) throw new SensitivityError(`Unknown variable '${varA}'`);
  if (!inputB) throw new SensitivityError(`Unknown variable '${varB}'`);

  const scenarioCtx = model.evaluate(scenarioAbs);
  if (!(metric in scenarioCtx)) {
    throw new SensitivityError(
      `Unknown target metric '${metric}'. Available metrics: ${model.outputIds.join(", ")}`,
    );
  }
  const baseMetricValue = scenarioCtx[metric] ?? 0;
  const scenA = scenarioAbs[varA] ?? inputA.base;
  const scenB = scenarioAbs[varB] ?? inputB.base;

  const valuesA = resolveSwingValues(scenA, inputMetricType(inputA), swingsA, percentSwingPp, baseMetricValue);
  const valuesB = resolveSwingValues(scenB, inputMetricType(inputB), swingsB, percentSwingPp, baseMetricValue);

  const grid: number[][] = [];
  for (const a of valuesA) {
    const row: number[] = [];
    for (const b of valuesB) {
      const out = model.evaluate({ ...scenarioAbs, [varA]: a, [varB]: b });
      row.push(round2(out[metric] ?? 0));
    }
    grid.push(row);
  }

  return {
    target_metric: metric,
    variable_a: varA,
    variable_b: varB,
    variable_a_name: inputA.name,
    variable_b_name: inputB.name,
    base_metric_value: round2(baseMetricValue),
    swings_a: swingsA,
    swings_b: swingsB,
    grid,
    values_a: valuesA.map(round2),
    values_b: valuesB.map(round2),
  };
}

export async function runSensitivity(
  scenarioId: string,
  targetMetric = "net_income",
  swingPct = 20,
  percentSwingPp?: number,
): Promise<SensitivityResult> {
  const resolved = await getEvaluableModelForScenario(scenarioId);
  const model = resolved.model;

  const overrides = await loadScenarioOverrides(scenarioId);
  const { absolute: scenarioAbs, unresolved } = resolveOverridesToAbsolute(model, overrides);

  const notices: string[] = [];
  if (unresolved.length > 0) {
    notices.push(
      `Percent overrides for ${unresolved.join(", ")} could not be applied (no non-zero base value).`,
    );
  }

  const swingByVariable = await loadSwingByVariableFromMc(scenarioId, model, scenarioAbs);
  if (swingByVariable && Object.keys(swingByVariable).length > 0) {
    notices.push(
      `Using Monte Carlo fitted volatility for swing magnitudes on ${Object.keys(swingByVariable).join(", ")}.`,
    );
  }

  const computed =
    model.kind === "dimensional" && model instanceof DimensionalModel
      ? computeTornadoDimensional(model, toDimensionalOverrides(overrides), targetMetric, {
          swingPct,
          percentSwingPp,
          swingByVariable,
        })
      : computeTornado(model, scenarioAbs, targetMetric, {
          swingPct,
          percentSwingPp,
          swingByVariable,
        });

  await pool.query(
    `INSERT INTO scenario_outputs (scenario_id, output_type, output_data) VALUES ($1, 'sensitivity', $2)`,
    [scenarioId, JSON.stringify({
      target_metric: targetMetric,
      swing_pct: computed.swing_pct,
      percent_swing_pp: computed.percent_swing_pp,
      scenario_applied: true,
      bars: computed.bars,
      ...(swingByVariable ? { swing_by_variable: swingByVariable } : {}),
      ...(notices.length > 0 ? { notices } : {}),
    })],
  );

  return {
    target_metric: targetMetric,
    swing_pct: computed.swing_pct,
    percent_swing_pp: computed.percent_swing_pp,
    base_metric_value: computed.base_metric_value,
    scenario_applied: true,
    bars: computed.bars,
    ...(swingByVariable ? { swing_by_variable: swingByVariable } : {}),
    ...(notices.length > 0 ? { notices } : {}),
  };
}

/**
 * Derive per-driver ±1σ swings from the latest Monte Carlo fitted_assumptions
 * (or distribution configs stored on the MC output). Relative for currency;
 * absolute σ for percent/ratio.
 */
export async function loadSwingByVariableFromMc(
  scenarioId: string,
  model: EvaluableModel,
  scenarioAbs: Record<string, number>,
): Promise<Record<string, number> | undefined> {
  const r = await pool.query(
    `SELECT output_data FROM scenario_outputs
     WHERE scenario_id = $1 AND output_type = 'monte_carlo'
     ORDER BY created_at DESC LIMIT 1`,
    [scenarioId],
  );
  if (r.rows.length === 0) return undefined;
  const data = r.rows[0].output_data as {
    fitted_assumptions?: {
      distributions?: Array<{
        variable_id: string;
        stddev?: number;
        base_value?: number;
        delta_type?: string;
        type?: string;
      }>;
    };
  };
  const dists = data.fitted_assumptions?.distributions;
  if (!dists?.length) return undefined;

  const inputById = new Map(model.inputs.map((i) => [i.id, i]));
  const out: Record<string, number> = {};
  for (const d of dists) {
    if (!d.variable_id || d.stddev == null || !Number.isFinite(d.stddev) || d.stddev <= 0) continue;
    const input = inputById.get(d.variable_id);
    if (!input) continue;
    const mt = input.metricType ?? "unknown";
    const base = scenarioAbs[d.variable_id] ?? input.base ?? d.base_value ?? 0;
    if (mt === "percent" || mt === "ratio") {
      out[d.variable_id] = d.stddev;
    } else if (Math.abs(base) > 1e-12) {
      // Relative swing = σ / |base|, capped to sane range
      out[d.variable_id] = Math.min(Math.max(d.stddev / Math.abs(base), 0.01), 0.75);
    } else {
      out[d.variable_id] = d.stddev;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export async function runTwoWaySensitivity(
  scenarioId: string,
  targetMetric: string,
  varA: string,
  varB: string,
  swings?: number[],
  swingByVariable?: Record<string, number[]>,
  percentSwingPp?: number,
): Promise<TwoWayGridResult> {
  const resolved = await getEvaluableModelForScenario(scenarioId);
  const model = resolved.model;
  const overrides = await loadScenarioOverrides(scenarioId);
  const { absolute: scenarioAbs, unresolved } = resolveOverridesToAbsolute(model, overrides);

  const notices: string[] = [];
  if (unresolved.length > 0) {
    notices.push(
      `Percent overrides for ${unresolved.join(", ")} could not be applied (no non-zero base value).`,
    );
  }

  const pp = percentSwingPp ?? 5;
  let resolvedSwingByVar = swingByVariable;
  if (!resolvedSwingByVar || Object.keys(resolvedSwingByVar).length === 0) {
    const mcScalars = await loadSwingByVariableFromMc(scenarioId, model, scenarioAbs);
    if (mcScalars && Object.keys(mcScalars).length > 0) {
      const steps = [-1, -0.5, 0, 0.5, 1];
      resolvedSwingByVar = {};
      for (const [id, mag] of Object.entries(mcScalars)) {
        if (!Number.isFinite(mag) || mag <= 0) continue;
        const input = model.inputs.find((i) => i.id === id);
        const mt = input ? inputMetricType(input) : "unknown";
        if (mt === "percent") {
          // resolveSwingValues: scenarioVal + s * percentSwingPp * 5 → want ±k*mag
          const denom = pp * 5;
          resolvedSwingByVar[id] = steps.map((k) => (denom > 0 ? (k * mag) / denom : k * mag));
        } else {
          // ratio: absolute add; currency/count: relative (1+s)
          resolvedSwingByVar[id] = steps.map((k) => k * mag);
        }
      }
      if (Object.keys(resolvedSwingByVar).length > 0) {
        notices.push(
          `Using Monte Carlo fitted volatility for two-way swings on ${Object.keys(resolvedSwingByVar).join(", ")}.`,
        );
      } else {
        resolvedSwingByVar = undefined;
      }
    }
  }

  const computed = computeTwoWayGrid(model, scenarioAbs, targetMetric, varA, varB, {
    swings,
    swingByVariable: resolvedSwingByVar,
    percentSwingPp: pp,
  });

  await pool.query(
    `INSERT INTO scenario_outputs (scenario_id, output_type, output_data) VALUES ($1, 'sensitivity_two_way', $2)`,
    [scenarioId, JSON.stringify({ ...computed, ...(notices.length > 0 ? { notices } : {}) })],
  );

  return {
    ...computed,
    ...(notices.length > 0 ? { notices } : {}),
  };
}
