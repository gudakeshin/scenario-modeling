/**
 * Shared denomination / currency-unit normalization for XLSX and CSV ingestion.
 * Detects labels like Crore/Cr, Lakh/Lac/Lacs, Million, Billion, Thousand
 * and rescales numeric values to a canonical unit (Million by default).
 */

export type CurrencyUnit = "Crore" | "Lakh" | "Million" | "Billion" | "Thousand";

export type CanonicalUnit = "Million";

/** Canonical store unit for all aggregated / simulated currency amounts. */
export const CANONICAL_UNIT: CanonicalUnit = "Million";

/** Multipliers that convert a source unit into absolute (ones). */
const UNIT_TO_ONES: Record<CurrencyUnit, number> = {
  Thousand: 1_000,
  Lakh: 100_000,
  Million: 1_000_000,
  Crore: 10_000_000,
  Billion: 1_000_000_000,
};

const KNOWN_CURRENCIES = new Set(["INR", "USD", "EUR", "GBP", "AED", "SGD", "JPY", "CNY", "AUD", "CAD", "CHF"]);

/** Tokens that must never be treated as ISO currency codes. */
const CURRENCY_BLOCKLIST = new Set([
  "TOTAL",
  "NOTES",
  "NOTE",
  "AMOUNT",
  "VALUE",
  "FIGURE",
  "FIGURES",
  "UNIT",
  "UNITS",
  "PAGE",
  "TABLE",
  "SHEET",
  "YEAR",
  "FY",
  "Q1",
  "Q2",
  "Q3",
  "Q4",
  "YTD",
  "MTD",
  "H1",
  "H2",
  "ALL",
  "NET",
  "GROSS",
  "OTHER",
  "MISC",
]);

export interface DenominationMeta {
  currency?: string;
  unit?: CurrencyUnit;
  evidence: string[];
  /** FX rate used to convert into workspace currency (1 source = rate target). */
  fx_rate?: number;
  fx_assumption?: string;
}

export interface CanonicalAmount {
  /** Value in CANONICAL_UNIT of the target currency. */
  value: number;
  canonical_unit: CanonicalUnit;
  source_unit?: CurrencyUnit;
  source_currency?: string;
  target_currency?: string;
  fx_rate?: number;
  fx_assumption?: string;
}

/**
 * Exact / token-aware currency detection.
 * Rejects short non-currency tokens like TOTAL / NOTES.
 */
export function normalizeCurrencyCode(value?: string | null): string | undefined {
  if (!value) return undefined;
  const raw = value.trim();
  if (!raw) return undefined;
  const v = raw.toUpperCase();

  if (/\bINR\b|\bRS\.?\b|\bRUPEES?\b|₹/.test(v)) return "INR";
  if (/\bUSD\b|\bUS\$\b|\bU\.S\.?\s*DOLLARS?\b/.test(v)) return "USD";
  if (/\bEUR\b|\bEUROS?\b|€/.test(v)) return "EUR";
  if (/\bGBP\b|\bPOUNDS?\b|£/.test(v)) return "GBP";
  if (/\bAED\b/.test(v)) return "AED";
  if (/\bSGD\b/.test(v)) return "SGD";
  if (/\bJPY\b|\bYEN\b|¥/.test(v)) return "JPY";
  if (/\bCNY\b|\bRMB\b/.test(v)) return "CNY";
  if (/\bAUD\b/.test(v)) return "AUD";
  if (/\bCAD\b/.test(v)) return "CAD";
  if (/\bCHF\b/.test(v)) return "CHF";

  // Bare "$" without US/USD context → USD only when not INR-rupee context
  if (/(?<![A-Z])\$(?!\s*cr)/.test(raw) && !/\bINR\b|\bRS\b|₹|RUPEE/i.test(raw)) return "USD";

  // Isolated ISO-like token only when known or clearly a 3-letter code and not blocklisted
  const isolated = v.match(/^[A-Z]{3}$/);
  if (isolated) {
    if (CURRENCY_BLOCKLIST.has(isolated[0])) return undefined;
    if (KNOWN_CURRENCIES.has(isolated[0])) return isolated[0];
    return undefined;
  }

  // Do not accept arbitrary short strings as currencies (former bug: TOTAL/NOTES)
  return undefined;
}

export function normalizeCurrencyUnit(value?: string | null): CurrencyUnit | undefined {
  if (!value) return undefined;
  const v = value.trim().toLowerCase();
  if (/\bmillion\b|\bmillions\b|\bmn\b|\bmio\b/.test(v)) return "Million";
  if (/\bbillion\b|\bbillions\b|\bbn\b/.test(v)) return "Billion";
  if (/\bthousand\b|\bthousands\b|\b'000\b|\b000s\b/.test(v)) return "Thousand";
  if (/\bcrore\b|\bcrores\b|\bcr\b/.test(v)) return "Crore";
  if (/\blakh\b|\blakhs\b|\blac\b|\blacs\b/.test(v)) return "Lakh";
  return undefined;
}

/** Convert a source-denominated amount into absolute ones (unit = 1). */
export function toOnes(value: number, unit: CurrencyUnit = "Million"): number {
  if (!Number.isFinite(value)) return value;
  return value * UNIT_TO_ONES[unit];
}

/** Convert absolute ones into the canonical store unit (Million). */
export function onesToCanonical(ones: number): number {
  if (!Number.isFinite(ones)) return ones;
  return ones / UNIT_TO_ONES[CANONICAL_UNIT];
}

/**
 * Rescale a source value into the canonical unit (Million), optionally
 * applying an FX rate into a target currency.
 */
export function toCanonical(
  value: number,
  opts: {
    unit?: CurrencyUnit | null;
    currency?: string | null;
    targetCurrency?: string | null;
    fxRate?: number | null;
    fxAssumption?: string | null;
  } = {},
): CanonicalAmount {
  const sourceUnit = opts.unit ?? CANONICAL_UNIT;
  const sourceCurrency = opts.currency ?? undefined;
  const targetCurrency = opts.targetCurrency ?? sourceCurrency;
  let ones = toOnes(value, sourceUnit);

  let fxRate: number | undefined;
  let fxAssumption: string | undefined;
  if (
    sourceCurrency &&
    targetCurrency &&
    sourceCurrency !== targetCurrency
  ) {
    if (opts.fxRate == null || !Number.isFinite(opts.fxRate) || opts.fxRate <= 0) {
      throw new MixedCurrencyError(sourceCurrency, targetCurrency);
    }
    fxRate = opts.fxRate;
    fxAssumption = opts.fxAssumption ?? `1 ${sourceCurrency} = ${fxRate} ${targetCurrency}`;
    ones *= fxRate;
  }

  return {
    value: onesToCanonical(ones),
    canonical_unit: CANONICAL_UNIT,
    source_unit: sourceUnit,
    source_currency: sourceCurrency,
    target_currency: targetCurrency,
    ...(fxRate != null ? { fx_rate: fxRate } : {}),
    ...(fxAssumption ? { fx_assumption: fxAssumption } : {}),
  };
}

export class MixedCurrencyError extends Error {
  readonly sourceCurrency: string;
  readonly targetCurrency: string;

  constructor(sourceCurrency: string, targetCurrency: string) {
    super(
      `Mixed currencies (${sourceCurrency} vs ${targetCurrency}) cannot be aggregated without an explicit FX assumption`,
    );
    this.name = "MixedCurrencyError";
    this.sourceCurrency = sourceCurrency;
    this.targetCurrency = targetCurrency;
  }
}

/** Detect currency + unit from free text (headers, footnotes, sheet notes). */
export function detectDenominationFromText(text: string): DenominationMeta {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const currencyScore = new Map<string, number>();
  const unitScore = new Map<string, number>();
  const evidence: string[] = [];

  const add = (map: Map<string, number>, key: string, weight: number) => {
    map.set(key, (map.get(key) || 0) + weight);
  };

  for (const line of lines) {
    const lower = line.toLowerCase();
    const isHint =
      /\ball figures in\b|\bfigures in\b|\bamounts? in\b|\bcurrency\b|\bdenomination\b|\bin\s+(inr|usd|rs|eur|gbp)/i.test(
        lower,
      );
    const weight = isHint ? 5 : 1;

    const currency = normalizeCurrencyCode(line);
    if (currency) add(currencyScore, currency, weight);

    const unit = normalizeCurrencyUnit(line);
    if (unit) add(unitScore, unit, weight);

    if (isHint && evidence.length < 15) evidence.push(line);
  }

  const top = (map: Map<string, number>) =>
    [...map.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

  return {
    currency: top(currencyScore),
    unit: top(unitScore) as CurrencyUnit | undefined,
    evidence,
  };
}

/**
 * Reconcile competing denomination signals (sheet vs document vs LLM).
 * Graph/ingestion signals win over LLM guesses.
 */
export function reconcileDenomination(
  primary: DenominationMeta,
  secondary?: DenominationMeta | null,
): DenominationMeta & { warnings: string[] } {
  const warnings: string[] = [];
  const currency = primary.currency ?? secondary?.currency;
  const unit = primary.unit ?? secondary?.unit;
  if (primary.currency && secondary?.currency && primary.currency !== secondary.currency) {
    warnings.push(
      `Currency mismatch: primary=${primary.currency}, secondary=${secondary.currency}; using ${currency}`,
    );
  }
  if (primary.unit && secondary?.unit && primary.unit !== secondary.unit) {
    warnings.push(
      `Unit mismatch: primary=${primary.unit}, secondary=${secondary.unit}; using ${unit}`,
    );
  }
  return {
    currency,
    unit,
    evidence: [...(primary.evidence ?? []), ...(secondary?.evidence ?? [])].slice(0, 20),
    ...(primary.fx_rate != null ? { fx_rate: primary.fx_rate } : {}),
    ...(primary.fx_assumption ? { fx_assumption: primary.fx_assumption } : {}),
    warnings,
  };
}
