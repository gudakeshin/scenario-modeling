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
import {
  getEvaluableModelForScenario,
  loadScenarioOverrides,
  resolveOverridesToAbsolute,
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
}

export interface ComputeTornadoOpts {
  swingPct?: number;
  /** Percentage-point swing for percent-type inputs. Default: swingPct / 4. */
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

    let low: number;
    let high: number;
    let absoluteStep = false;
    let swingUnit: SwingUnit = "relative";
    let stepSize: number | undefined;

    if (scenarioVal === 0) {
      const step = Math.max(Math.abs(baseMetricValue) * 0.01, 1);
      low = -step;
      high = step;
      absoluteStep = true;
      swingUnit = "absolute";
      stepSize = step;
    } else if (mt === "percent") {
      // Percentage points (default 20% relative → ±5pp)
      low = Math.max(0, scenarioVal - percentSwingPp);
      high = scenarioVal + percentSwingPp;
      swingUnit = "pp";
      stepSize = percentSwingPp;
    } else if (mt === "ratio") {
      const absSwing = (swingPct / 100) * 1.0;
      low = scenarioVal - absSwing;
      high = scenarioVal + absSwing;
      swingUnit = "absolute";
      stepSize = absSwing;
    } else {
      low = scenarioVal * (1 - swing);
      high = scenarioVal * (1 + swing);
      swingUnit = "relative";
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

  const computed = computeTornado(model, scenarioAbs, targetMetric, {
    swingPct,
    percentSwingPp,
  });

  await pool.query(
    `INSERT INTO scenario_outputs (scenario_id, output_type, output_data) VALUES ($1, 'sensitivity', $2)`,
    [scenarioId, JSON.stringify({
      target_metric: targetMetric,
      swing_pct: computed.swing_pct,
      percent_swing_pp: computed.percent_swing_pp,
      scenario_applied: true,
      bars: computed.bars,
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
    ...(notices.length > 0 ? { notices } : {}),
  };
}
