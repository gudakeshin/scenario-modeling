/**
 * Sensitivity Analysis / Tornado Chart Service
 *
 * One-at-a-time perturbation: each input is swung ±X% around its value in
 * the SCENARIO being analyzed (base + the scenario's own parameter
 * overrides — previously the overrides were loaded but never applied, so
 * the tornado was always centered on the model base instead).
 *
 * Inputs whose scenario value is exactly 0 are perturbed by an absolute
 * step instead of being skipped, and are annotated as such.
 */

import { pool } from "../db/index.js";
import {
  getEvaluableModelForScenario,
  loadScenarioOverrides,
  resolveOverridesToAbsolute,
} from "./modelResolver.js";

export interface TornadoBar {
  variable_id: string;
  variable_name: string;
  low_value: number;    // metric value when variable is at -swing%
  high_value: number;   // metric value when variable is at +swing%
  base_value: number;   // metric value at the scenario baseline
  low_delta: number;    // low_value - base_value
  high_delta: number;   // high_value - base_value
  spread: number;       // |high_value - low_value|
  /** True when the input's scenario value was 0 and an absolute step was used. */
  absolute_step?: boolean;
}

export interface SensitivityResult {
  target_metric: string;
  swing_pct: number;
  /** Metric value at the scenario baseline (scenario overrides applied). */
  base_metric_value: number;
  /** Overrides from the scenario were applied before perturbation. */
  scenario_applied: boolean;
  bars: TornadoBar[];
  notices?: string[];
}

class SensitivityError extends Error {
  status = 422;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export async function runSensitivity(
  scenarioId: string,
  targetMetric = "net_income",
  swingPct = 20
): Promise<SensitivityResult> {
  const resolved = await getEvaluableModelForScenario(scenarioId);
  const model = resolved.model;

  // Scenario baseline: model base + the scenario's own overrides
  const overrides = await loadScenarioOverrides(scenarioId);
  const { absolute: scenarioAbs, unresolved } = resolveOverridesToAbsolute(model, overrides);
  const scenarioCtx = model.evaluate(scenarioAbs);

  if (!(targetMetric in scenarioCtx)) {
    throw new SensitivityError(
      `Unknown target metric '${targetMetric}'. Available metrics: ${model.outputIds.join(", ")}`,
    );
  }
  const baseMetricValue = scenarioCtx[targetMetric] ?? 0;

  const bars: TornadoBar[] = [];
  const swing = swingPct / 100;
  const notices: string[] = [];
  if (unresolved.length > 0) {
    notices.push(
      `Percent overrides for ${unresolved.join(", ")} could not be applied (no non-zero base value).`,
    );
  }

  for (const input of model.inputs) {
    // The input's value in the scenario (override if present, else base)
    const scenarioVal = scenarioAbs[input.id] ?? input.base;

    let low: number;
    let high: number;
    let absoluteStep = false;
    if (scenarioVal === 0) {
      // Zero baseline: swing by an absolute step derived from the model
      // base (or ±1.0 as a last resort) instead of dropping the driver.
      const step = Math.abs(input.base) > 0 ? Math.abs(input.base) * swing : swing * 5;
      low = -step;
      high = step;
      absoluteStep = true;
    } else {
      low = scenarioVal * (1 - swing);
      high = scenarioVal * (1 + swing);
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
      ...(absoluteStep ? { absolute_step: true } : {}),
    });
  }

  // Sort by spread descending (widest impact first)
  bars.sort((a, b) => b.spread - a.spread);

  // Store result
  await pool.query(
    `INSERT INTO scenario_outputs (scenario_id, output_type, output_data) VALUES ($1, 'sensitivity', $2)`,
    [scenarioId, JSON.stringify({
      target_metric: targetMetric,
      swing_pct: swingPct,
      scenario_applied: true,
      bars,
      ...(notices.length > 0 ? { notices } : {}),
    })]
  );

  return {
    target_metric: targetMetric,
    swing_pct: swingPct,
    base_metric_value: round2(baseMetricValue),
    scenario_applied: true,
    bars,
    ...(notices.length > 0 ? { notices } : {}),
  };
}
