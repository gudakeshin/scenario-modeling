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

/** Deloitte-branded colors for chart metrics */
export const METRIC_COLORS: Record<string, string> = {
  revenue: "#86BC25",      // Deloitte Green
  cogs: "#DA291C",         // Deloitte Red
  gross_margin: "#007CB0", // Deloitte Blue
  opex: "#E87722",         // Deloitte Orange
  ebitda: "#62B5E5",       // Light Blue
  net_income: "#1D1D1B",   // Charcoal
  units_sold: "#43B02A",   // Green alt
  unit_price: "#7C4DFF",   // Purple
  raw_material_cost: "#FF6F00", // Amber
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
