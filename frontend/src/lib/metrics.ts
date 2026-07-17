/**
 * Shared metric constants — single source of truth for P&L labels, ordering, and colors.
 *
 * All components should import from here instead of defining their own METRIC_LABELS.
 */

/** Canonical display order for P&L metrics */
export const METRIC_ORDER = [
  "revenue",
  "cogs",
  "gross_margin",
  "opex",
  "ebitda",
  "net_income",
] as const;

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
}

export function setPreferDisplayUnit(unit: DisplayUnit | "auto") {
  _preferUnit = unit;
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
  if (/ratio|turnover/.test(text)) return "ratio";
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
