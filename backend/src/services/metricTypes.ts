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
  // "ratio"/"turnover" must sit on a token boundary (snake_case ids join
  // words with "_", so \b alone doesn't help — "_" is a word character). A
  // bare substring test mistook "revenue_from_operations" for a ratio,
  // since "operations" contains "ratio" (ope-RATIO-ns).
  if (/(^|[^a-z])(ratio|turnover)([^a-z]|$)/i.test(text)) return "ratio";
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

// ── Canonical metric identity ──

/**
 * Canonical P&L metric ids that the accounting guardrails, aggregation rules,
 * and UI ordering are written against.
 */
export const CANONICAL_METRICS = [
  "revenue",
  "cogs",
  "gross_profit",
  "gross_margin",
  "opex",
  "ebitda",
  "ebitda_margin",
  "ebit",
  "operating_income",
  "operating_margin",
  "net_income",
  "net_margin",
  "depreciation",
  "interest",
  "tax",
] as const;

export type CanonicalMetric = (typeof CANONICAL_METRICS)[number];

/**
 * Workbook-specific ids → canonical ids.
 *
 * Every invariant in financialInvariants and every ordering rule in the UI keys
 * off the canonical name. A model that reports "gross_revenue" and
 * "material_vehicle_cost" therefore passed every check by matching none of
 * them, and rendered a one-bar waterfall. Mapping is by exact id first, then by
 * pattern, so an unrecognised id stays unmapped rather than being coerced.
 */
const CANONICAL_ALIASES: Record<string, CanonicalMetric> = {
  net_revenue: "revenue",
  gross_revenue: "revenue",
  total_revenue: "revenue",
  revenue_from_operations: "revenue",
  revenue_cr: "revenue",
  net_sales: "revenue",
  sales: "revenue",
  turnover: "revenue",

  cost_of_revenue: "cogs",
  cost_of_goods_sold: "cogs",
  cost_of_sales: "cogs",
  material_cost: "cogs",
  material_vehicle_cost: "cogs",
  raw_material_cost: "cogs",

  total_opex: "opex",
  operating_expenses: "opex",
  total_operating_expenses: "opex",

  gross_margin_pct: "gross_margin",
  ebitda_margin_pct: "ebitda_margin",

  profit_before_tax: "net_income",
  profit_after_tax: "net_income",
  net_profit: "net_income",
  pat: "net_income",

  operating_profit: "operating_income",
  depreciation_amortization: "depreciation",
  finance_cost: "interest",
  interest_expense: "interest",
  tax_expense: "tax",
};

/** Ordered pattern fallbacks for ids the alias table does not name outright. */
const CANONICAL_PATTERNS: Array<[RegExp, CanonicalMetric]> = [
  [/^(net_|gross_|total_)?revenue(_|$)/, "revenue"],
  [/(^|_)ebitda_margin(_|$)/, "ebitda_margin"],
  [/(^|_)gross_margin(_|$)/, "gross_margin"],
  [/(^|_)net_margin(_|$)/, "net_margin"],
  [/(^|_)operating_margin(_|$)/, "operating_margin"],
  [/(^|_)gross_profit(_|$)/, "gross_profit"],
  [/(^|_)ebitda(_|$)/, "ebitda"],
  [/(^|_)ebit(_|$)/, "ebit"],
];

const CANONICAL_SET = new Set<string>(CANONICAL_METRICS);

/**
 * Resolve a model-specific metric id to its canonical name, or undefined when
 * the id has no canonical counterpart (a model-specific line item).
 */
export function canonicalMetricId(id: string): CanonicalMetric | undefined {
  const key = id.trim().toLowerCase();
  if (!key) return undefined;
  if (CANONICAL_SET.has(key)) return key as CanonicalMetric;
  const alias = CANONICAL_ALIASES[key];
  if (alias) return alias;
  for (const [pattern, canonical] of CANONICAL_PATTERNS) {
    if (pattern.test(key)) return canonical;
  }
  return undefined;
}

/**
 * Project a metric map onto canonical ids, keeping the original entries.
 *
 * Guardrails can then look up `revenue` on a model that only ever says
 * `gross_revenue`, without the model's own vocabulary being rewritten. When
 * several ids map to the same canonical name the more specific one wins:
 * `net_revenue` is a better `revenue` than `gross_revenue`.
 */
const CANONICAL_PREFERENCE: Record<string, string[]> = {
  revenue: ["revenue", "net_revenue", "revenue_from_operations", "total_revenue", "gross_revenue"],
  cogs: ["cogs", "cost_of_revenue", "cost_of_goods_sold", "material_vehicle_cost"],
  opex: ["opex", "total_opex", "operating_expenses"],
  net_income: ["net_income", "net_profit", "profit_after_tax", "pat", "profit_before_tax"],
};

export function withCanonicalMetrics(
  values: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = { ...values };
  const byCanonical = new Map<string, string[]>();

  for (const id of Object.keys(values)) {
    const canonical = canonicalMetricId(id);
    if (!canonical || canonical === id) continue;
    const group = byCanonical.get(canonical);
    if (group) group.push(id);
    else byCanonical.set(canonical, [id]);
  }

  for (const [canonical, sourceIds] of byCanonical) {
    if (canonical in out) continue;
    const preference = CANONICAL_PREFERENCE[canonical] ?? [];
    const rank = (id: string) => {
      const i = preference.indexOf(id);
      return i < 0 ? Number.MAX_SAFE_INTEGER : i;
    };
    const source = [...sourceIds].sort((a, b) => rank(a) - rank(b))[0];
    const value = values[source];
    if (Number.isFinite(value)) out[canonical] = value;
  }

  return out;
}
