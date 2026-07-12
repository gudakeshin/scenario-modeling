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
