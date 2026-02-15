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
