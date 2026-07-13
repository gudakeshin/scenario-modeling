/**
 * Metric-type inference for ModelVariables that lack an explicit metric_type
 * (legacy stored models built before plumbing).
 */

export type MetricType = "currency" | "count" | "percent" | "ratio" | "volume" | "unknown";

export type VariableProvenance = "extracted" | "assumed" | "derived";

/**
 * Infer metric type from a variable id / name for legacy models.
 * Prefer an explicit `metric_type` on the variable when present.
 */
export function inferMetricTypeFromId(id: string, name?: string): MetricType {
  const text = `${id} ${name ?? ""}`.toLowerCase();
  if (/margin|rate|growth|pct|percent/.test(text)) return "percent";
  if (/ratio|turnover/.test(text)) return "ratio";
  if (/headcount|fte|stores/.test(text)) return "count";
  if (/volume|units/.test(text)) return "volume";
  return "currency";
}

export function resolveMetricType(
  metricType: MetricType | undefined,
  id: string,
  name?: string,
): MetricType {
  return metricType ?? inferMetricTypeFromId(id, name);
}

export function isRatioLike(t: MetricType): boolean {
  return t === "percent" || t === "ratio";
}

export function isFlowLike(t: MetricType): boolean {
  return t === "currency" || t === "count" || t === "volume" || t === "unknown";
}

/** Preferred P&L targets when a caller defaults to net_income on a custom model. */
const TARGET_METRIC_PREFERENCE = [
  "net_income",
  "net_profit",
  "profit_after_tax",
  "pat",
  "profit_before_tax",
  "pbt",
  "ebitda",
  "ebit",
  "operating_income",
  "operating_profit",
  "gross_profit",
  "net_revenue",
  "gross_revenue",
  "revenue",
] as const;

/**
 * Pick a target metric that exists on the model.
 * Honors `preferred` when present; otherwise walks a P&L preference list,
 * then any non-margin output, then the first available id.
 */
export function pickDefaultTargetMetric(
  available: readonly string[],
  preferred?: string | null,
): string {
  const ids = available.filter((id) => typeof id === "string" && id.length > 0);
  if (ids.length === 0) return preferred?.trim() || "net_income";
  const set = new Set(ids);
  const pref = preferred?.trim();
  if (pref && set.has(pref)) return pref;
  for (const id of TARGET_METRIC_PREFERENCE) {
    if (set.has(id)) return id;
  }
  const nonMargin = ids.find((id) => !/margin|rate|pct|percent/i.test(id));
  return nonMargin ?? ids[0];
}
