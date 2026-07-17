/**
 * Indian digit grouping and scale-aware currency formatting for exports / PPTX.
 * Mirror of frontend/src/lib/metrics.ts display helpers — keep constants aligned
 * with denomination.ts UNIT_TO_ONES.
 */

const UNIT_TO_ONES = {
  Thousand: 1_000,
  Lakh: 100_000,
  Million: 1_000_000,
  Crore: 10_000_000,
  Billion: 1_000_000_000,
} as const;

export type DisplayUnit = keyof typeof UNIT_TO_ONES;

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$",
  EUR: "€",
  GBP: "£",
  INR: "₹",
  JPY: "¥",
  CNY: "¥",
};

const numberFormatCache = new Map<string, Intl.NumberFormat>();

function getIndianNumberFormat(opts: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = JSON.stringify(opts);
  let fmt = numberFormatCache.get(key);
  if (!fmt) {
    fmt = new Intl.NumberFormat("en-IN", opts);
    numberFormatCache.set(key, fmt);
  }
  return fmt;
}

export function fmtIndianNumber(
  n: number,
  opts: { maximumFractionDigits?: number; minimumFractionDigits?: number } = {},
): string {
  if (!Number.isFinite(n)) return String(n);
  return getIndianNumberFormat({
    maximumFractionDigits: opts.maximumFractionDigits ?? 0,
    minimumFractionDigits: opts.minimumFractionDigits,
  }).format(n);
}

export function fmtIndianCurrency(
  n: number,
  currency = "INR",
  opts: { maximumFractionDigits?: number } = {},
): string {
  const sym = CURRENCY_SYMBOLS[currency] || `${currency} `;
  return sym + fmtIndianNumber(Math.abs(n), opts);
}

/**
 * Format an absolute (ones) amount into a scale label preferred by Indian FP&A.
 * Prefer Crore when |n| ≥ 1e5 ones (₹1 Lakh), else Lakh, else ones with en-IN grouping.
 */
export function fmtIndianScale(
  nOnes: number,
  currency = "INR",
  preferUnit: DisplayUnit | "auto" = "auto",
): string {
  if (!Number.isFinite(nOnes)) return String(nOnes);
  const sym = CURRENCY_SYMBOLS[currency] || `${currency} `;
  const abs = Math.abs(nOnes);
  const sign = nOnes < 0 ? "-" : "";

  let unit: DisplayUnit;
  if (preferUnit !== "auto") {
    unit = preferUnit;
  } else if (abs >= UNIT_TO_ONES.Crore) {
    unit = "Crore";
  } else if (abs >= UNIT_TO_ONES.Lakh) {
    unit = "Lakh";
  } else if (abs >= UNIT_TO_ONES.Thousand) {
    unit = "Thousand";
  } else {
    return `${sign}${sym}${fmtIndianNumber(abs, { maximumFractionDigits: 2 })}`;
  }

  const scaled = abs / UNIT_TO_ONES[unit];
  const short =
    unit === "Crore" ? "Cr" : unit === "Lakh" ? "L" : unit === "Million" ? "Mn" : unit === "Billion" ? "Bn" : "K";
  return `${sign}${sym} ${fmtIndianNumber(scaled, { maximumFractionDigits: 2 })} ${short}`;
}
