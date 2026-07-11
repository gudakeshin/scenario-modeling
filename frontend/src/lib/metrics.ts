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
  opex: "OpEx",
  ebitda: "EBITDA",
  net_income: "Net Income",
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

let _currency = "USD";
let _currencyUnit = "";

export function setCurrency(code: string, unit?: string) {
  _currency = code || "USD";
  _currencyUnit = unit || "";
}

export function getCurrencySymbol(): string {
  return CURRENCY_SYMBOLS[_currency] || _currency + " ";
}

export function getCurrencyLabel(): string {
  const sym = getCurrencySymbol();
  return _currencyUnit ? `${sym} ${_currencyUnit}` : sym;
}

export function fmtCurrency(n: number): string {
  const sym = getCurrencySymbol();
  return sym + Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 0 });
}

export function fmtCurrencySigned(n: number): string {
  const prefix = n >= 0 ? "+" : "-";
  return prefix + fmtCurrency(Math.abs(n));
}
