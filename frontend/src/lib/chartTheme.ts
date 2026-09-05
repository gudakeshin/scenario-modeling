/**
 * Chart color tokens — CSS-var driven so charts follow the theme (incl.
 * dark mode) instead of hardcoded hex values baked into each chart file.
 * Recharts renders plain SVG, and modern browsers resolve `var(--x)`
 * directly in `fill`/`stroke` attributes, so these strings can be passed
 * straight into chart props.
 */
export const chartColors = {
  positive: "var(--chart-positive)",
  negative: "var(--chart-negative)",
  neutral: "var(--chart-neutral)",
  accent2: "var(--chart-accent-2)",
  accent3: "var(--chart-accent-3)",
  grid: "var(--chart-grid)",
  axisText: "var(--chart-axis-text)",
  accent: "var(--accent)",
} as const;

/** Ordered palette for multi-series charts (comparison, metric breakdowns). */
export const chartSeriesPalette = [
  chartColors.neutral,
  chartColors.positive,
  chartColors.accent3,
  chartColors.accent2,
  chartColors.negative,
] as const;

/**
 * Compact number formatting: 1_234_567 -> "1.2M", 950 -> "950", -12_000 -> "-12K".
 * Replaces the old `(v/1000).toFixed(0)+"k"` pattern, which rendered
 * millions as "1000k" and collapsed sub-1000 values to "0k".
 */
export function formatCompact(value: number, opts: { maximumFractionDigits?: number } = {}): string {
  if (!Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: opts.maximumFractionDigits ?? 1,
  }).format(value);
}

/** Compact formatting with a currency symbol prefix, sign-aware. */
export function formatCompactCurrency(value: number, symbol: string): string {
  const sign = value < 0 ? "-" : "";
  return `${sign}${symbol}${formatCompact(Math.abs(value))}`;
}
