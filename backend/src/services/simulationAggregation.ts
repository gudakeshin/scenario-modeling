/**
 * Period aggregation helpers for formula-DAG and XLSX simulations.
 * Percent/ratio metrics are never summed across periods.
 */

import type { ModelDefinition, ModelVariable } from "../models/registry.js";
import type { CompiledModel } from "./expression.js";
import { inferMetricTypeFromId, isRatioLike, resolveMetricType, canonicalMetricId } from "./metricTypes.js";
import { medianOutliers } from "./dataQuality.js";

export interface PeriodPlSnapshot {
  period: string;
  pl: Record<string, number>;
  variables: Record<string, number>;
}

export interface AggregatePeriodPlResult {
  aggregate: Record<string, number>;
  warnings: string[];
}

function isFiniteNumber(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

function varMeta(modelDef: ModelDefinition, id: string): ModelVariable | undefined {
  return modelDef.variables.find((v) => v.id === id);
}

/** Infer a flow denominator for weighting ratio/percent inputs. */
export function inferRatioDenominator(
  modelDef: ModelDefinition,
  ratioId: string,
): string | undefined {
  const meta = varMeta(modelDef, ratioId);
  const explicit = (meta as ModelVariable & { weight_by?: string })?.weight_by;
  if (explicit && modelDef.variables.some((v) => v.id === explicit)) return explicit;

  // Prefer revenue for margins / rates
  if (/margin|rate|pct|percent|ratio/i.test(ratioId) && modelDef.variables.some((v) => v.id === "revenue")) {
    return "revenue";
  }

  // Use first currency-like dependency if present on a calculated margin
  if (meta?.dependencies?.length) {
    for (const d of meta.dependencies) {
      const dep = varMeta(modelDef, d);
      const mt = resolveMetricType(dep?.metric_type, d, dep?.name);
      if (!isRatioLike(mt)) return d;
    }
  }
  return undefined;
}

/**
 * Weight ratio values by a flow denominator across periods.
 * Falls back to simple mean when no valid weights exist.
 */
export function weightedRatioAverage(
  periods: PeriodPlSnapshot[],
  ratioId: string,
  weightId: string | undefined,
): { value: number; weighted: boolean } {
  if (periods.length === 0) return { value: 0, weighted: false };

  if (weightId) {
    let weightedSum = 0;
    let weightTotal = 0;
    for (const p of periods) {
      const ratio = p.pl[ratioId] ?? p.variables[ratioId] ?? 0;
      const w = Math.abs(p.pl[weightId] ?? p.variables[weightId] ?? 0);
      if (!Number.isFinite(ratio) || !Number.isFinite(w) || w <= 0) continue;
      weightedSum += ratio * w;
      weightTotal += w;
    }
    if (weightTotal > 0) {
      return { value: weightedSum / weightTotal, weighted: true };
    }
  }

  let sum = 0;
  let n = 0;
  for (const p of periods) {
    const ratio = p.pl[ratioId] ?? p.variables[ratioId];
    if (ratio == null || !Number.isFinite(ratio)) continue;
    sum += ratio;
    n += 1;
  }
  return { value: n > 0 ? sum / n : 0, weighted: false };
}

/**
 * Aggregate per-period P&L into a single totals map.
 * - currency/count/volume/unknown → sum
 * - percent/ratio calculated → re-evaluate DAG on period-summed flow inputs
 * - percent/ratio inputs → denominator-weighted average (mean fallback)
 */
export function aggregatePeriodPl(
  model: CompiledModel,
  modelDef: ModelDefinition,
  periods: PeriodPlSnapshot[],
  _scenarioAbs: Record<string, number>,
): Record<string, number> {
  return aggregatePeriodPlDetailed(model, modelDef, periods, _scenarioAbs).aggregate;
}

export function aggregatePeriodPlDetailed(
  model: CompiledModel,
  modelDef: ModelDefinition,
  periods: PeriodPlSnapshot[],
  _scenarioAbs: Record<string, number>,
): AggregatePeriodPlResult {
  void _scenarioAbs;
  const warnings: string[] = [];
  const plMetricIds = modelDef.variables
    .filter((v) => v.tags?.includes("pl_metric"))
    .map((v) => v.id);

  if (periods.length === 0) return { aggregate: {}, warnings };

  // Build aggregated absolute inputs for ratio recompute
  const inputIds = model.inputs.map((i) => i.id);
  const aggInputs: Record<string, number> = {};
  for (const id of inputIds) {
    const meta = varMeta(modelDef, id);
    const mt = resolveMetricType(meta?.metric_type, id, meta?.name);
    if (isRatioLike(mt)) {
      const denom = inferRatioDenominator(modelDef, id);
      const { value, weighted } = weightedRatioAverage(periods, id, denom);
      aggInputs[id] = value;
      if (!weighted && periods.length > 1) {
        warnings.push(
          `Ratio input "${id}" aggregated with simple mean (no valid weight denominator)`,
        );
      }
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
        const denom = inferRatioDenominator(modelDef, id);
        const { value, weighted } = weightedRatioAverage(periods, id, denom);
        aggregate[id] = (value);
        if (!weighted && periods.length > 1) {
          warnings.push(
            `Ratio metric "${id}" aggregated with simple mean (no valid weight denominator)`,
          );
        }
      } else {
        const v = recomputed[id];
        if (v != null && Number.isFinite(v)) aggregate[id] = (v);
      }
    } else {
      let total = 0;
      for (const p of periods) total += p.pl[id] || 0;
      aggregate[id] = (total);
    }
  }
  return { aggregate, warnings };
}

/**
 * Ratio-aware aggregation for XLSX multi-period outputs (no CompiledModel DAG).
 * Flow metrics sum; percent/ratio metrics use revenue-weighted average (mean fallback).
 */
export function aggregateXlsxPeriodPl(
  periods: PeriodPlSnapshot[],
  outputIds: string[],
  metricHints?: Record<string, string>,
): AggregatePeriodPlResult {
  const warnings: string[] = [];
  if (periods.length === 0) return { aggregate: {}, warnings };

  // Find the revenue line under whatever name the model uses. Looking only for
  // the literal id "revenue" meant a model reporting "net_revenue" fell back to
  // an unweighted mean of monthly margins — which is not the annual margin.
  const revenueId = (() => {
    const candidates = new Set<string>([
      ...outputIds,
      ...periods.flatMap((p) => [...Object.keys(p.pl), ...Object.keys(p.variables)]),
    ]);
    const preference = ["revenue", "net_revenue", "revenue_from_operations", "total_revenue", "gross_revenue"];
    for (const id of preference) {
      if (!candidates.has(id)) continue;
      const hasValue = periods.some(
        (p) => Number.isFinite(p.pl[id]) || Number.isFinite(p.variables[id]),
      );
      if (hasValue) return id;
    }
    for (const id of candidates) {
      if (canonicalMetricId(id) !== "revenue") continue;
      const hasValue = periods.some(
        (p) => Number.isFinite(p.pl[id]) || Number.isFinite(p.variables[id]),
      );
      if (hasValue) return id;
    }
    return undefined;
  })();

  const aggregate: Record<string, number> = {};
  for (const id of outputIds) {
    const hint = metricHints?.[id];
    const mt = resolveMetricType(
      hint as import("./metricTypes.js").MetricType | undefined,
      id,
      hint,
    );
    if (isRatioLike(mt) || (mt === "unknown" && isRatioLike(inferMetricTypeFromId(id)))) {
      const denom = revenueId;
      const { value, weighted } = weightedRatioAverage(periods, id, denom);
      aggregate[id] = (value);
      if (!weighted && periods.length > 1) {
        warnings.push(
          `Ratio metric "${id}" aggregated with simple mean (no valid weight denominator)`,
        );
      }
    } else {
      let total = 0;
      let n = 0;
      for (const p of periods) {
        const v = p.pl[id] ?? p.variables[id];
        if (v == null || !Number.isFinite(v)) continue;
        total += v;
        n += 1;
      }
      if (n > 0) aggregate[id] = (total);
    }
  }
  return { aggregate, warnings };
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


/**
 * Periods whose value is wildly out of line with their siblings.
 *
 * A single corrupt cell in a source schedule propagates into the P&L and then
 * into the annual total, where it is invisible: the year is simply too big.
 * Comparing each period against the median of the others surfaces it while the
 * numbers are still per-period. Median-based so the outlier cannot mask itself.
 */
export function detectPeriodOutliers(
  periods: Array<{ period: string; pl: Record<string, number> }>,
  metricIds: string[],
  factor = 10,
): string[] {
  if (periods.length < 4) return [];

  // Group by period, not by metric. One bad month lands on every line of the
  // P&L, and reporting each line separately says the same thing six times while
  // obscuring that they share a cause.
  const affectedByPeriod = new Map<string, Array<{ metric: string; value: number; median: number }>>();

  for (const metricId of metricIds) {
    // Ratios legitimately stay flat or swing; only flow metrics are comparable.
    if (/margin|rate|pct|percent|ratio/i.test(metricId)) continue;

    const values = periods
      .map((p) => ({ label: p.period, value: p.pl[metricId] }))
      .filter((v): v is { label: string; value: number } => Number.isFinite(v.value));

    const result = medianOutliers(values, factor);
    if (!result) continue;

    for (const outlier of result.outliers) {
      const entry = affectedByPeriod.get(outlier.label) ?? [];
      entry.push({ metric: metricId, value: outlier.value, median: result.median });
      affectedByPeriod.set(outlier.label, entry);
    }
  }

  const fmt = (n: number) => n.toLocaleString("en-IN", { maximumFractionDigits: 2 });
  return [...affectedByPeriod.entries()].map(([period, metrics]) => {
    const lead = metrics[0];
    const others = metrics.slice(1).map((m) => m.metric);
    return (
      `Period outlier: ${period} is far out of line with the other ${periods.length - 1} periods — ` +
      `${lead.metric} is ${fmt(lead.value)} against a median of ${fmt(lead.median)}` +
      `${others.length > 0 ? `, and the same applies to ${others.join(", ")}` : ""}. ` +
      `The annual total carries this difference.`
    );
  });
}
