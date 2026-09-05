/**
 * Shared metric constants — single source of truth for P&L labels, ordering, and colors.
 *
 * All components should import from here instead of defining their own METRIC_LABELS.
 */

import { useSyncExternalStore } from "react";

/**
 * Canonical display order for P&L metrics — all six are absolute currency
 * lines. `gross_margin` (a percentage — see inferMetricType below, which
 * treats every "*margin*" id as percent) must NOT sit in this list: the
 * waterfall reads this array as its bridge and does `value - running` on
 * each entry, and a ~0.57 fraction fed through that arithmetic collapses to
 * `-running` — i.e. the "Gross Margin" bar reads as the negative of
 * whatever ran before it (Revenue, when COGS wasn't separately captured),
 * so Revenue and "Gross Margin" show the same magnitude on the chart.
 * `gross_profit` is the actual absolute figure this step needs.
 */
export const METRIC_ORDER = [
  "revenue",
  "cogs",
  "gross_profit",
  "opex",
  "ebitda",
  "net_income",
] as const;

/**
 * Workbook-specific metric ids → the canonical ids the UI orders and colours by.
 * Mirrors backend metricTypes.canonicalMetricId.
 *
 * Without this a model that reports `gross_revenue` / `material_vehicle_cost` /
 * `total_opex` intersects METRIC_ORDER only at `ebitda`, and the P&L waterfall
 * renders a single bar.
 */
const CANONICAL_ALIASES: Record<string, string> = {
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
  profit_before_tax: "net_income",
  profit_after_tax: "net_income",
  net_profit: "net_income",
  pat: "net_income",
  operating_profit: "operating_income",
};

/** Preferred source when several model ids map to the same canonical metric. */
const CANONICAL_PREFERENCE: Record<string, string[]> = {
  revenue: ["revenue", "net_revenue", "revenue_from_operations", "total_revenue", "gross_revenue"],
  cogs: ["cogs", "cost_of_revenue", "cost_of_goods_sold", "material_vehicle_cost"],
  opex: ["opex", "total_opex", "operating_expenses"],
  net_income: ["net_income", "net_profit", "profit_after_tax", "pat", "profit_before_tax"],
};

/** Canonical id for a model-specific metric id, or undefined when it has none. */
export function canonicalMetricId(id: string): string | undefined {
  const key = id.trim().toLowerCase();
  if (!key) return undefined;
  if ((METRIC_ORDER as readonly string[]).includes(key)) return key;
  return CANONICAL_ALIASES[key];
}

/**
 * Add canonical entries for a P&L map without discarding the model's own ids,
 * so charts can rely on canonical names while tables still show real labels.
 */
export function withCanonicalMetrics(
  values: Record<string, number> | undefined | null,
): Record<string, number> {
  if (!values) return {};
  const out: Record<string, number> = { ...values };
  const grouped = new Map<string, string[]>();

  for (const id of Object.keys(values)) {
    const canonical = canonicalMetricId(id);
    if (!canonical || canonical === id) continue;
    const group = grouped.get(canonical);
    if (group) group.push(id);
    else grouped.set(canonical, [id]);
  }

  for (const [canonical, sourceIds] of grouped) {
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

/** Human-readable labels for all model metrics (P&L + input variables) */
export const METRIC_LABELS: Record<string, string> = {
  revenue: "Revenue",
  cogs: "COGS",
  gross_margin: "Gross Margin",
  gross_profit: "Gross Profit",
  opex: "OpEx",
  ebitda: "EBITDA",
  ebitda_margin: "EBITDA Margin",
  operating_income: "Operating Income",
  operating_margin: "Operating Margin",
  net_income: "Net Income",
  net_margin: "Net Margin",
  units_sold: "Units Sold",
  unit_price: "Unit Price",
  raw_material_cost: "Raw Materials",
};

/**
 * Chart colors for P&L metrics — CSS-var driven (see lib/chartTheme.ts) so
 * they follow the active theme (incl. dark mode) instead of fixed hex.
 */
export const METRIC_COLORS: Record<string, string> = {
  revenue: "var(--chart-positive)",
  cogs: "var(--chart-negative)",
  gross_margin: "var(--chart-neutral)",
  gross_profit: "var(--chart-neutral)",
  opex: "var(--chart-accent-3)",
  ebitda: "var(--accent)",
  net_income: "var(--text-primary)",
  units_sold: "var(--chart-positive)",
  unit_price: "var(--chart-accent-2)",
  raw_material_cost: "var(--chart-accent-3)",
};

/** Format a metric key into a label, using the map with fallback to title-case */
export function metricLabel(key: string): string {
  return METRIC_LABELS[key] ?? key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// ── Currency ──

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$", EUR: "€", GBP: "£", INR: "₹", JPY: "¥", CNY: "¥",
  AUD: "A$", CAD: "C$", CHF: "CHF ", SGD: "S$", HKD: "HK$",
  KRW: "₩", BRL: "R$", ZAR: "R", MXN: "MX$", SEK: "kr",
};

/** Ones multipliers — keep aligned with backend denomination.ts */
const UNIT_TO_ONES = {
  Thousand: 1_000,
  Lakh: 100_000,
  Million: 1_000_000,
  Crore: 10_000_000,
  Billion: 1_000_000_000,
} as const;

export type DisplayUnit = keyof typeof UNIT_TO_ONES;

let _currency = "USD";
let _currencyUnit = "";
/** Workspace preference for scale display (Crore vs Million). */
let _preferUnit: DisplayUnit | "auto" = "auto";

/**
 * `_currency`/`_currencyUnit` are read by plain functions (fmtMetric,
 * fmtCurrency, …) called straight from JSX, not through React state — a
 * component that renders once before the workspace's real currency loads
 * (a fast panel like Driver Tree beating the slower onboarding-status
 * fetch, or a workspace switch mid-session) keeps showing the stale "$"
 * default forever, because nothing tells React to re-render it once the
 * real value arrives. `useCurrencyVersion` gives components a value that
 * changes on every setCurrency call, so subscribing to it forces exactly
 * that re-render.
 */
let _version = 0;
const _listeners = new Set<() => void>();
function bumpVersion() {
  _version++;
  for (const l of _listeners) l();
}
function subscribeCurrency(onChange: () => void): () => void {
  _listeners.add(onChange);
  return () => _listeners.delete(onChange);
}
function getCurrencyVersion() {
  return _version;
}
/** Call in any component that formats amounts via this module, so it
 *  re-renders when the workspace's real currency/unit finishes loading. */
export function useCurrencyVersion(): number {
  return useSyncExternalStore(subscribeCurrency, getCurrencyVersion, getCurrencyVersion);
}

const numberFormatCache = new Map<string, Intl.NumberFormat>();

function indianFmt(opts: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = JSON.stringify(opts);
  let fmt = numberFormatCache.get(key);
  if (!fmt) {
    fmt = new Intl.NumberFormat("en-IN", opts);
    numberFormatCache.set(key, fmt);
  }
  return fmt;
}

export function setCurrency(code: string, unit?: string) {
  _currency = code || "USD";
  _currencyUnit = unit || "";
  bumpVersion();
}

export function setPreferDisplayUnit(unit: DisplayUnit | "auto") {
  _preferUnit = unit;
  bumpVersion();
}

export function getCurrencySymbol(): string {
  return CURRENCY_SYMBOLS[_currency] || _currency + " ";
}

export function getCurrencyLabel(): string {
  const sym = getCurrencySymbol();
  return _currencyUnit ? `${sym} ${_currencyUnit}` : sym;
}

export function fmtIndianNumber(
  n: number,
  opts: { maximumFractionDigits?: number; minimumFractionDigits?: number } = {},
): string {
  if (!Number.isFinite(n)) return String(n);
  return indianFmt({
    maximumFractionDigits: opts.maximumFractionDigits ?? 0,
    minimumFractionDigits: opts.minimumFractionDigits,
  }).format(n);
}

/**
 * Format absolute (ones) amounts with Indian scale labels.
 * When `_currencyUnit` is Crore/Lakh/Million, values are treated as already in that unit.
 */
export function fmtIndianScale(n: number, onesAlready = false): string {
  if (!Number.isFinite(n)) return String(n);
  const sym = getCurrencySymbol();
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);

  // If workspace already stores in a known unit, format that unit directly.
  const unitFromMeta = (_currencyUnit || "") as DisplayUnit | "";
  if (!onesAlready && unitFromMeta && unitFromMeta in UNIT_TO_ONES) {
    const short =
      unitFromMeta === "Crore" ? "Cr" :
      unitFromMeta === "Lakh" ? "L" :
      unitFromMeta === "Million" ? "Mn" :
      unitFromMeta === "Billion" ? "Bn" : "K";
    return `${sign}${sym} ${fmtIndianNumber(abs, { maximumFractionDigits: 2 })} ${short}`;
  }

  const ones = onesAlready
    ? abs
    : abs * (unitFromMeta && unitFromMeta in UNIT_TO_ONES ? UNIT_TO_ONES[unitFromMeta as DisplayUnit] : 1);

  let unit: DisplayUnit;
  if (_preferUnit !== "auto") unit = _preferUnit;
  else if (ones >= UNIT_TO_ONES.Crore) unit = "Crore";
  else if (ones >= UNIT_TO_ONES.Lakh) unit = "Lakh";
  else if (ones >= UNIT_TO_ONES.Thousand) unit = "Thousand";
  else return `${sign}${sym}${fmtIndianNumber(ones, { maximumFractionDigits: 2 })}`;

  const scaled = ones / UNIT_TO_ONES[unit];
  const short =
    unit === "Crore" ? "Cr" : unit === "Lakh" ? "L" : unit === "Million" ? "Mn" : unit === "Billion" ? "Bn" : "K";
  return `${sign}${sym} ${fmtIndianNumber(scaled, { maximumFractionDigits: 2 })} ${short}`;
}

export function fmtCurrency(n: number): string {
  const sym = getCurrencySymbol();
  // Prefer scale-aware Indian formatting when currency is INR or unit is Indian.
  if (_currency === "INR" || /crore|lakh|cr\b|lac/i.test(_currencyUnit)) {
    return fmtIndianScale(n);
  }
  return sym + fmtIndianNumber(Math.abs(n), { maximumFractionDigits: 0 });
}

export function fmtCurrencySigned(n: number): string {
  const prefix = n >= 0 ? "+" : "-";
  return prefix + fmtCurrency(Math.abs(n));
}

export type MetricType = "currency" | "count" | "percent" | "ratio" | "volume" | "unknown";

/** Infer display type from metric id / label (mirrors backend metricTypes). */
export function inferMetricType(id: string, name?: string): MetricType {
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

/**
 * Format a percent/ratio value for display.
 * Values with |n| ≤ 1 are treated as fractions (0.25 → 25%); larger values as percent points.
 */
export function fmtPercent(n: number): string {
  const pct = Math.abs(n) > 0 && Math.abs(n) <= 1 ? n * 100 : n;
  return `${fmtIndianNumber(pct, { maximumFractionDigits: 1 })}%`;
}

export function fmtPercentSigned(n: number): string {
  const prefix = n >= 0 ? "+" : "-";
  return prefix + fmtPercent(Math.abs(n));
}

/** Format any metric value using its id (and optional name) to pick units. */
export function fmtMetric(id: string, n: number, name?: string): string {
  const kind = inferMetricType(id, name);
  if (kind === "percent") return fmtPercent(n);
  if (kind === "ratio") {
    return `${fmtIndianNumber(n, { maximumFractionDigits: 2 })}x`;
  }
  if (kind === "count" || kind === "volume") {
    return fmtIndianNumber(n, { maximumFractionDigits: 0 });
  }
  return fmtCurrency(n);
}

export function fmtMetricSigned(id: string, n: number, name?: string): string {
  const kind = inferMetricType(id, name);
  if (kind === "percent") return fmtPercentSigned(n);
  if (kind === "ratio") {
    const prefix = n >= 0 ? "+" : "-";
    return `${prefix}${fmtIndianNumber(Math.abs(n), { maximumFractionDigits: 2 })}x`;
  }
  if (kind === "count" || kind === "volume") {
    const prefix = n >= 0 ? "+" : "-";
    return `${prefix}${fmtIndianNumber(Math.abs(n), { maximumFractionDigits: 0 })}`;
  }
  return fmtCurrencySigned(n);
}

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

/** Pick a target metric that exists on the active model (avoids hardcoding net_income). */
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

/** Format simulation fidelity violations for chat / notices. */
export function formatFidelityViolations(
  fidelity?: {
    applied_repairs?: string[];
    violations?: Array<{ severity: string; message: string }>;
    normalized?: boolean;
  } | null,
): string | null {
  if (!fidelity) return null;
  const lines: string[] = [];
  if (fidelity.applied_repairs?.length) {
    lines.push(
      "**Fidelity repairs applied:**\n" +
        fidelity.applied_repairs.map((r) => `- ${r}`).join("\n"),
    );
  }
  if (fidelity.violations?.length) {
    lines.push(
      "**Residual fidelity issues:**\n" +
        fidelity.violations.map((v) => `- [${v.severity}] ${v.message}`).join("\n"),
    );
  }
  return lines.length > 0 ? lines.join("\n\n") : null;
}
