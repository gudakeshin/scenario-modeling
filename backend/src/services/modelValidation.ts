/**
 * Cross-foot / tie-out validation for extracted P&L metrics.
 *
 * Warns when a calculated metric's extracted typical_value disagrees with
 * evaluating its formula against extracted inputs — extraction errors stay
 * authoritative; we never block simulation.
 */

import { compileFormula } from "./expression.js";

/** Minimal metric shape — avoids importing contextEngine (circular). */
export interface TieOutMetric {
  name: string;
  variable_id: string;
  typical_value?: number;
  is_input: boolean;
  formula?: string;
  dependencies?: string[];
}

export interface TieOutVariance {
  variable_id: string;
  extracted: number;
  computed: number;
  variance_pct: number;
  message: string;
}

const SAFE_FN_NAMES = new Set(["min", "max", "abs", "round", "floor", "ceil", "sqrt", "pow"]);

function formatNum(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/**
 * For each non-input metric with a formula and finite typical_value, evaluate
 * the formula against extracted dependency values. Record variances > tolerancePct.
 */
export function crossFootExtractedPL(
  metrics: TieOutMetric[],
  tolerancePct = 1,
): TieOutVariance[] {
  const byId = new Map(metrics.map((m) => [m.variable_id, m]));
  const knownIds = new Set(metrics.map((m) => m.variable_id));
  const variances: TieOutVariance[] = [];

  for (const m of metrics) {
    if (m.is_input) continue;
    if (m.typical_value == null || !Number.isFinite(m.typical_value)) continue;
    if (!m.formula || /^-?\d+(\.\d+)?$/.test(m.formula.trim())) continue;

    const deps = m.dependencies?.length
      ? m.dependencies
      : [...(m.formula.match(/\b[a-z][a-z0-9_]*\b/g) || [])].filter(
          (id) => knownIds.has(id) && id !== m.variable_id && !SAFE_FN_NAMES.has(id),
        );

    let skip = false;
    const ctx: Record<string, number> = {};
    for (const d of deps) {
      const dep = byId.get(d);
      if (!dep || dep.typical_value == null || !Number.isFinite(dep.typical_value)) {
        skip = true;
        break;
      }
      ctx[d] = dep.typical_value;
    }
    if (skip) continue;

    let computed: number;
    try {
      const fn = compileFormula(m.formula, knownIds, m.variable_id);
      computed = fn(ctx, {
        min: Math.min,
        max: Math.max,
        abs: Math.abs,
        round: Math.round,
        floor: Math.floor,
        ceil: Math.ceil,
        sqrt: Math.sqrt,
        pow: Math.pow,
      });
    } catch {
      continue;
    }
    if (!Number.isFinite(computed)) continue;

    const extracted = m.typical_value;
    const denom = Math.abs(extracted) > 1e-9 ? Math.abs(extracted) : Math.abs(computed);
    if (denom < 1e-9) continue;
    const variancePct = (Math.abs(extracted - computed) / denom) * 100;
    if (variancePct <= tolerancePct) continue;

    const message =
      `Tie-out: extracted ${m.variable_id} (${formatNum(extracted)}) differs from ` +
      `${m.formula} (${formatNum(computed)}) by ${variancePct.toFixed(1)}%`;

    variances.push({
      variable_id: m.variable_id,
      extracted,
      computed,
      variance_pct: Math.round(variancePct * 10) / 10,
      message,
    });
  }

  // Consistency: EBIT == EBITDA while D&A > 0 is a structural red flag
  const ebit = byId.get("ebit") ?? byId.get("operating_profit");
  const ebitda = byId.get("ebitda");
  const da =
    byId.get("depreciation_amortization") ??
    byId.get("depreciation");
  if (
    ebit?.typical_value != null &&
    ebitda?.typical_value != null &&
    da?.typical_value != null &&
    Number.isFinite(ebit.typical_value) &&
    Number.isFinite(ebitda.typical_value) &&
    da.typical_value > 0
  ) {
    const gap = Math.abs(ebit.typical_value - ebitda.typical_value);
    const denom = Math.max(Math.abs(ebitda.typical_value), 1);
    if ((gap / denom) * 100 <= tolerancePct) {
      variances.push({
        variable_id: "ebit",
        extracted: ebit.typical_value,
        computed: ebitda.typical_value - da.typical_value,
        variance_pct: Math.round((da.typical_value / denom) * 1000) / 10,
        message:
          `Tie-out: extracted ebit (${formatNum(ebit.typical_value)}) equals ebitda ` +
          `(${formatNum(ebitda.typical_value)}) while D&A is ${formatNum(da.typical_value)} — ` +
          `opex may incorrectly include depreciation`,
      });
    }
  }

  return variances;
}
