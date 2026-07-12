/**
 * Period aggregation helpers for formula-DAG simulations.
 * Percent/ratio metrics are never summed across periods.
 */

import type { ModelDefinition, ModelVariable } from "../models/registry.js";
import type { CompiledModel } from "./expression.js";
import { isRatioLike, resolveMetricType } from "./metricTypes.js";

export interface PeriodPlSnapshot {
  period: string;
  pl: Record<string, number>;
  variables: Record<string, number>;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function varMeta(modelDef: ModelDefinition, id: string): ModelVariable | undefined {
  return modelDef.variables.find((v) => v.id === id);
}

/**
 * Aggregate per-period P&L into a single totals map.
 * - currency/count/volume/unknown → sum
 * - percent/ratio calculated → re-evaluate DAG on period-summed flow inputs
 * - percent/ratio inputs → period-weighted average
 */
export function aggregatePeriodPl(
  model: CompiledModel,
  modelDef: ModelDefinition,
  periods: PeriodPlSnapshot[],
  _scenarioAbs: Record<string, number>,
): Record<string, number> {
  void _scenarioAbs;
  const plMetricIds = modelDef.variables
    .filter((v) => v.tags?.includes("pl_metric"))
    .map((v) => v.id);

  if (periods.length === 0) return {};

  // Build aggregated absolute inputs for ratio recompute
  const inputIds = model.inputs.map((i) => i.id);
  const aggInputs: Record<string, number> = {};
  for (const id of inputIds) {
    const meta = varMeta(modelDef, id);
    const mt = resolveMetricType(meta?.metric_type, id, meta?.name);
    if (isRatioLike(mt)) {
      let sum = 0;
      for (const p of periods) sum += p.variables[id] ?? 0;
      aggInputs[id] = sum / periods.length;
    } else {
      let sum = 0;
      for (const p of periods) sum += p.variables[id] ?? 0;
      aggInputs[id] = sum;
    }
  }
  const recomputed = model.evaluate(aggInputs);

  const aggregate: Record<string, number> = {};
  for (const id of plMetricIds) {
    const meta = varMeta(modelDef, id);
    const mt = resolveMetricType(meta?.metric_type, id, meta?.name);
    if (isRatioLike(mt)) {
      if (meta && meta.dependencies.length === 0) {
        // percent/ratio input — average
        let sum = 0;
        for (const p of periods) sum += p.pl[id] ?? p.variables[id] ?? 0;
        aggregate[id] = round2(sum / periods.length);
      } else {
        aggregate[id] = round2(recomputed[id] ?? 0);
      }
    } else {
      let total = 0;
      for (const p of periods) total += p.pl[id] || 0;
      aggregate[id] = round2(total);
    }
  }
  return aggregate;
}

/**
 * True when any variable requests per-period compound growth.
 */
export function hasPeriodGrowth(modelDef: ModelDefinition): boolean {
  return modelDef.variables.some(
    (v) => v.period_growth_pct != null && Number.isFinite(v.period_growth_pct) && v.period_growth_pct !== 0,
  );
}

/**
 * Build absolute overrides for period t (0-indexed).
 * Flow inputs with period_growth_pct compound; percent/ratio inputs never compound.
 */
export function periodOverrides(
  modelDef: ModelDefinition,
  baseAbs: Record<string, number>,
  periodIndex: number,
  fallbackBase?: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = { ...baseAbs };
  for (const v of modelDef.variables) {
    if (v.dependencies.length > 0) continue;
    if (v.period_growth_pct == null || !Number.isFinite(v.period_growth_pct) || v.period_growth_pct === 0) {
      continue;
    }
    const mt = resolveMetricType(v.metric_type, v.id, v.name);
    if (isRatioLike(mt)) continue;
    // Scenario override wins as the period-0 base; otherwise grow from the model base.
    const base = baseAbs[v.id] ?? fallbackBase?.[v.id];
    if (base == null || !Number.isFinite(base)) continue;
    out[v.id] = base * Math.pow(1 + v.period_growth_pct / 100, periodIndex);
  }
  return out;
}
