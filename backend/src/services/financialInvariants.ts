/**
 * Deterministic financial-invariant checks and safe repairs.
 * Pure — no LLM. Reused by every-sim guard, model-build review, audit, and agent gate.
 */

import { config } from "../config.js";
import { selectKnownFormula } from "./contextEngine.js";
import { compileFormula } from "./expression.js";
import { inferMetricTypeFromId, isRatioLike } from "./metricTypes.js";

export type InvariantSeverity = "error" | "warning";

export interface InvariantViolation {
  code: string;
  severity: InvariantSeverity;
  metric: string;
  message: string;
  expected?: number;
  actual?: number;
}

export interface NormalizationResult {
  pl: Record<string, number>;
  applied: string[];
  residualViolations: InvariantViolation[];
}

export interface CheckInvariantsOpts {
  /** Relative tolerance for identity cross-foot (fraction). Defaults to IDENTITY_REPAIR_TOLERANCE. */
  identityTolerance?: number;
  /** Skip identity cross-foot (ordering + ratio bounds only). */
  skipIdentity?: boolean;
}

const ORDERING_CHAINS: Array<{ higher: string; lower: string; code: string }> = [
  { higher: "revenue", lower: "gross_profit", code: "order_revenue_gp" },
  { higher: "gross_profit", lower: "operating_income", code: "order_gp_oi" },
  { higher: "revenue", lower: "ebitda", code: "order_revenue_ebitda" },
  { higher: "ebitda", lower: "ebit", code: "order_ebitda_ebit" },
  { higher: "profit_before_tax", lower: "net_income", code: "order_pbt_ni" },
  { higher: "profit_before_tax", lower: "net_profit", code: "order_pbt_np" },
];

/** Margin ids that must not exceed 100% (or fall far below -100%). */
const MARGIN_BOUNDS: Record<string, { max: number; min: number }> = {
  gross_margin: { max: 100, min: -100 },
  ebitda_margin: { max: 100, min: -200 },
  operating_margin: { max: 100, min: -200 },
  net_margin: { max: 100, min: -200 },
};

const RATIO_RECOMPUTE: Record<string, { num: string; den: string; asPercent: boolean }> = {
  gross_margin: { num: "gross_profit", den: "revenue", asPercent: true },
  ebitda_margin: { num: "ebitda", den: "revenue", asPercent: true },
  operating_margin: { num: "operating_income", den: "revenue", asPercent: true },
  net_margin: { num: "net_income", den: "revenue", asPercent: true },
};

const SAFE_FNS = {
  min: Math.min,
  max: Math.max,
  abs: Math.abs,
  round: Math.round,
  floor: Math.floor,
  ceil: Math.ceil,
  sqrt: Math.sqrt,
  pow: Math.pow,
};

function present(pl: Record<string, number>, id: string): boolean {
  const v = pl[id];
  return v != null && Number.isFinite(v);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function relativeVariance(expected: number, actual: number): number {
  const denom = Math.max(Math.abs(expected), Math.abs(actual), 1e-9);
  return Math.abs(expected - actual) / denom;
}

function evalIdentity(
  formula: string,
  deps: string[],
  pl: Record<string, number>,
  metricId: string,
): number | null {
  const knownIds = new Set([...deps, ...Object.keys(pl)]);
  try {
    const fn = compileFormula(formula, knownIds, metricId);
    const ctx: Record<string, number> = {};
    for (const d of deps) {
      if (!present(pl, d)) return null;
      ctx[d] = pl[d];
    }
    const computed = fn(ctx, SAFE_FNS);
    return Number.isFinite(computed) ? computed : null;
  } catch {
    return null;
  }
}

/**
 * Check P&L ordering, identity cross-foot, and ratio bounds.
 */
export function checkInvariants(
  pl: Record<string, number>,
  opts?: CheckInvariantsOpts,
): InvariantViolation[] {
  const violations: InvariantViolation[] = [];
  const tol = opts?.identityTolerance ?? config.IDENTITY_REPAIR_TOLERANCE ?? 0.01;

  for (const { higher, lower, code } of ORDERING_CHAINS) {
    if (!present(pl, higher) || !present(pl, lower)) continue;
    // Ordering allows negatives; higher should be ≥ lower in normal P&L stack.
    // Skip when both are deeply negative atypical (still flag if higher < lower).
    if (pl[higher] + 1e-6 < pl[lower]) {
      violations.push({
        code,
        severity: "error",
        metric: lower,
        message: `${higher} (${pl[higher]}) must be ≥ ${lower} (${pl[lower]})`,
        expected: pl[higher],
        actual: pl[lower],
      });
    }
  }

  // Alias: operating_income ≈ ebit when both present
  if (present(pl, "operating_income") && present(pl, "ebit")) {
    if (relativeVariance(pl.operating_income, pl.ebit) > Math.max(tol, 0.05)) {
      violations.push({
        code: "oi_ebit_mismatch",
        severity: "warning",
        metric: "operating_income",
        message: `operating_income (${pl.operating_income}) and ebit (${pl.ebit}) diverge`,
        expected: pl.operating_income,
        actual: pl.ebit,
      });
    }
  }

  if (!opts?.skipIdentity) {
    const available = new Set(Object.keys(pl).filter((k) => present(pl, k)));
    for (const metricId of available) {
      const known = selectKnownFormula(metricId, available);
      if (!known) continue;
      if (!present(pl, metricId)) continue;
      const computed = evalIdentity(known.formula, known.deps, pl, metricId);
      if (computed == null) continue;
      if (relativeVariance(pl[metricId], computed) > tol) {
        violations.push({
          code: `identity_${metricId}`,
          severity: "error",
          metric: metricId,
          message: `${metricId} (${pl[metricId]}) does not tie to ${known.formula} (= ${round2(computed)})`,
          expected: round2(computed),
          actual: pl[metricId],
        });
      }
    }
  }

  for (const [id, bounds] of Object.entries(MARGIN_BOUNDS)) {
    if (!present(pl, id)) continue;
    const mt = inferMetricTypeFromId(id);
    if (!isRatioLike(mt)) continue;
    const v = pl[id];
    if (v > bounds.max + 1e-6) {
      violations.push({
        code: `ratio_over_${id}`,
        severity: "error",
        metric: id,
        message: `${id} (${v}%) exceeds ${bounds.max}% — likely summed percents or bad numerator`,
        expected: bounds.max,
        actual: v,
      });
    } else if (v < bounds.min - 1e-6) {
      violations.push({
        code: `ratio_under_${id}`,
        severity: "warning",
        metric: id,
        message: `${id} (${v}%) is below ${bounds.min}%`,
        expected: bounds.min,
        actual: v,
      });
    }
  }

  // Generic: any ratio-like metric > 100% when named *margin*
  for (const [id, v] of Object.entries(pl)) {
    if (!present(pl, id) || MARGIN_BOUNDS[id]) continue;
    if (!isRatioLike(inferMetricTypeFromId(id))) continue;
    if (/margin/i.test(id) && v > 100 + 1e-6) {
      violations.push({
        code: `ratio_over_${id}`,
        severity: "error",
        metric: id,
        message: `${id} (${v}%) exceeds 100%`,
        expected: 100,
        actual: v,
      });
    }
  }

  return violations;
}

function recomputeRatios(pl: Record<string, number>, applied?: string[]): void {
  for (const [id, spec] of Object.entries(RATIO_RECOMPUTE)) {
    if (!present(pl, spec.num) || !present(pl, spec.den) || Math.abs(pl[spec.den]) < 1e-9) {
      continue;
    }
    const next = round2((pl[spec.num] / pl[spec.den]) * (spec.asPercent ? 100 : 1));
    if (!present(pl, id) || Math.abs(pl[id] - next) > 1e-6) {
      pl[id] = next;
      if (applied && !applied.some((a) => a.includes(id))) {
        applied.push(`recomputed ${id} from ${spec.num}/${spec.den}`);
      }
    }
  }
}

/**
 * Safe non-LLM repairs: recompute ratios; re-derive currency metrics from identities
 * when deps are present and the recomputed value reduces violations.
 */
export function attemptDeterministicNormalization(
  plIn: Record<string, number>,
  opts?: CheckInvariantsOpts,
): NormalizationResult {
  const pl = { ...plIn };
  const applied: string[] = [];
  const before = checkInvariants(pl, opts);

  // 1) Recompute known ratio metrics from numerator/denominator
  recomputeRatios(pl, applied);

  // 2) Re-derive violating currency metrics from known identities
  const available = new Set(Object.keys(pl).filter((k) => present(pl, k)));
  const currencyTargets = [
    "gross_profit",
    "ebitda",
    "ebit",
    "operating_income",
    "profit_before_tax",
    "net_income",
    "net_profit",
    "cost_of_revenue",
    "total_expenses",
  ];

  for (const metricId of currencyTargets) {
    const known = selectKnownFormula(metricId, available);
    if (!known) continue;
    const computed = evalIdentity(known.formula, known.deps, pl, metricId);
    if (computed == null) continue;

    const currentlyViolates = before.some(
      (v) =>
        v.metric === metricId ||
        (v.code.startsWith("order_") && (v.metric === metricId || v.message.includes(metricId))),
    );
    const identityMismatch =
      present(pl, metricId) &&
      relativeVariance(pl[metricId], computed) >
        (opts?.identityTolerance ?? config.IDENTITY_REPAIR_TOLERANCE ?? 0.01);

    if (!present(pl, metricId) || currentlyViolates || identityMismatch) {
      const trial = { ...pl, [metricId]: round2(computed) };
      recomputeRatios(trial);
      const trialViolations = checkInvariants(trial, opts);
      const beforeCount = checkInvariants(pl, opts).length;
      if (trialViolations.length < beforeCount) {
        Object.assign(pl, trial);
        available.add(metricId);
        applied.push(`re-derived ${metricId} via ${known.formula}`);
      }
    }
  }

  // 3) Sign-flip repair for OpEx when EBITDA = GP + |OpEx| pattern
  if (present(pl, "gross_profit") && present(pl, "ebitda")) {
    const opexKey = present(pl, "operating_expenses")
      ? "operating_expenses"
      : present(pl, "opex")
        ? "opex"
        : null;
    if (opexKey && present(pl, opexKey)) {
      const opexAbs = Math.abs(pl[opexKey]);
      const corrected = round2(pl.gross_profit - opexAbs);
      const additiveWrong = round2(pl.gross_profit + opexAbs);
      const looksAdditive =
        Math.abs(pl.ebitda - additiveWrong) <= Math.max(1, opexAbs * 0.05) ||
        (present(pl, "revenue") &&
          pl.ebitda > pl.revenue &&
          Math.abs(pl.ebitda - additiveWrong) < Math.abs(pl.ebitda - corrected));
      if (looksAdditive && Math.abs(pl.ebitda - corrected) > 1e-6) {
        const trial = { ...pl, ebitda: corrected, [opexKey]: opexAbs };
        recomputeRatios(trial);
        const trialViolations = checkInvariants(trial, opts);
        const beforeCount = checkInvariants(pl, opts).length;
        const fixesOrder =
          present(pl, "revenue") && corrected <= pl.revenue + 1e-6 && pl.ebitda > pl.revenue;
        if (trialViolations.length < beforeCount || fixesOrder) {
          Object.assign(pl, trial);
          applied.push(`sign-normalized ${opexKey}; re-derived ebitda = gross_profit - ${opexKey}`);
        }
      }
    }
  }

  // Final ratio pass
  recomputeRatios(pl, applied);

  return {
    pl,
    applied,
    residualViolations: checkInvariants(pl, opts),
  };
}

/** Build human-readable notices from violations + applied repairs. */
export function fidelityNotices(
  applied: string[],
  residual: InvariantViolation[],
): string[] {
  const notices: string[] = [];
  for (const a of applied) {
    notices.push(`Fidelity repair: ${a}`);
  }
  for (const v of residual) {
    notices.push(`Fidelity ${v.severity}: ${v.message}`);
  }
  return notices;
}

export interface FidelityBlock {
  checked: true;
  applied_repairs: string[];
  violations: InvariantViolation[];
  normalized: boolean;
}

export function buildFidelityBlock(
  applied: string[],
  residual: InvariantViolation[],
): FidelityBlock {
  return {
    checked: true,
    applied_repairs: applied,
    violations: residual,
    normalized: applied.length > 0,
  };
}
