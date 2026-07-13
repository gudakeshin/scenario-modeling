/**
 * Expression Engine — single source of truth for formula evaluation.
 *
 * Replaces the four copy-pasted string-substitution evaluators that
 * previously lived in simulationService, monteCarloService,
 * sensitivityService, and models/registry.
 *
 * Design:
 *  - Formulas are tokenized and validated (identifier whitelist), then
 *    compiled ONCE into a JS function. No per-iteration re-parsing.
 *  - Errors THROW (ExpressionError, naming the variable) instead of the
 *    old silent `return 0`, which produced plausible-looking wrong numbers.
 *  - `compileModel` wraps a ModelDefinition into an EvaluableModel — the
 *    engine-agnostic interface shared with the XLSX HyperFormula runtime,
 *    so Monte Carlo and sensitivity work identically on both.
 */

import type { ModelDefinition, ModelVariable } from "../models/registry.js";
import { inferMetricTypeFromId, type MetricType } from "./metricTypes.js";

export class ExpressionError extends Error {
  variableId?: string;
  status = 422;
  constructor(message: string, variableId?: string) {
    super(variableId ? `${message} (variable: ${variableId})` : message);
    this.variableId = variableId;
  }
}

// ── Typed deltas ──

export type DeltaType = "percent" | "absolute" | "additive";

export interface TypedOverride {
  value: number;
  delta_type: DeltaType;
}

/** Resolve a typed override against a base value to an absolute input value. */
export function resolveOverride(base: number, override: TypedOverride): number {
  if (!Number.isFinite(override.value)) return base;
  if (override.delta_type === "percent") {
    return base * (1 + override.value / 100);
  }
  if (override.delta_type === "additive") {
    return base + override.value;
  }
  return override.value;
}

// ── Formula compilation ──

type CompiledFn = (ctx: Record<string, number>, fns: typeof SAFE_FUNCTIONS) => number;

const SAFE_FUNCTIONS = {
  min: Math.min,
  max: Math.max,
  abs: Math.abs,
  round: Math.round,
  floor: Math.floor,
  ceil: Math.ceil,
  sqrt: Math.sqrt,
  pow: Math.pow,
};

const FUNCTION_NAMES = new Set(Object.keys(SAFE_FUNCTIONS));

const TOKEN_RE = /([A-Za-z_][A-Za-z0-9_]*)|(\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|([+\-*/%(),])|(\s+)|(.)/g;

const formulaCache = new Map<string, CompiledFn>();

/**
 * Compile a formula string into a function of (ctx, fns).
 * Throws ExpressionError on unknown identifiers or syntax problems.
 */
export function compileFormula(formula: string, knownIds: ReadonlySet<string>, variableId?: string): CompiledFn {
  const cacheKey = formula;
  const cached = formulaCache.get(cacheKey);
  if (cached) return cached;

  const src = formula.trim();
  if (!src) throw new ExpressionError("Empty formula", variableId);

  let js = "";
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  let lastWasIdentifier: string | null = null;

  while ((m = TOKEN_RE.exec(src)) !== null) {
    const [, ident, num, op, ws, other] = m;
    if (ws) continue;
    if (other) {
      throw new ExpressionError(`Unsupported character '${other}' in formula "${formula}"`, variableId);
    }
    if (ident) {
      lastWasIdentifier = ident;
      // Emit lazily: decide function vs variable when we see the next token
      // (function must be followed by '(').
      const next = src.slice(TOKEN_RE.lastIndex).match(/^\s*\(/);
      if (next && FUNCTION_NAMES.has(ident)) {
        js += `fns.${ident}`;
      } else if (knownIds.has(ident)) {
        js += `ctx[${JSON.stringify(ident)}]`;
      } else {
        throw new ExpressionError(
          `Unknown variable '${ident}' in formula "${formula}"`,
          variableId,
        );
      }
      continue;
    }
    if (num) {
      js += num;
      lastWasIdentifier = null;
      continue;
    }
    if (op) {
      js += op;
      lastWasIdentifier = null;
      continue;
    }
  }
  void lastWasIdentifier;

  let fn: CompiledFn;
  try {
    fn = new Function("ctx", "fns", `"use strict"; return (${js});`) as CompiledFn;
  } catch (e) {
    throw new ExpressionError(`Invalid formula "${formula}": ${(e as Error).message}`, variableId);
  }
  formulaCache.set(cacheKey, fn);
  return fn;
}

// ── Topological sort (shared) ──

export function topologicalSort(variables: { id: string; dependencies: string[] }[]): string[] {
  const order: string[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const byId = new Map(variables.map((v) => [v.id, v]));

  function visit(id: string) {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new ExpressionError(`Circular dependency involving '${id}'`, id);
    visiting.add(id);
    const v = byId.get(id);
    if (v) for (const d of v.dependencies) visit(d);
    visiting.delete(id);
    visited.add(id);
    order.push(id);
  }

  for (const v of variables) visit(v.id);
  return order; // DFS post-order: dependencies before dependents
}

// ── EvaluableModel: the engine-agnostic contract ──

export interface ModelInput {
  id: string;
  name: string;
  base: number;
  /** Present on formula-DAG models; XLSX inputs stay unknown / omitted. */
  metricType?: MetricType;
}

export interface PeriodSlice {
  period: string;
  values: Record<string, number>;
}

/**
 * A model that can be evaluated with absolute input overrides.
 * Implemented by CompiledModel (formula DAG) and XlsxModelRuntime (HyperFormula).
 */
export interface EvaluableModel {
  kind: "formula" | "xlsx" | "dimensional";
  /** Perturbable input variables with their base values. */
  inputs: ModelInput[];
  /** Metric ids reported by evaluate() (P&L metrics / KPI outputs). */
  outputIds: string[];
  /**
   * Evaluate the model. Keys of `absoluteOverrides` are input ids; values
   * are ABSOLUTE input values (delta resolution happens before this call).
   * Returns a map containing at least all outputIds and all input ids.
   */
  evaluate(absoluteOverrides: Record<string, number>): Record<string, number>;
  /** True when evaluatePeriods yields more than a single FY slice. */
  supportsPeriods?: boolean;
  /** Multi-period evaluation when the model has a time axis / horizon. */
  evaluatePeriods?(absoluteOverrides: Record<string, number>): PeriodSlice[];
}

// ── Time horizon helpers (kept here to avoid circular imports) ──

export function generatePeriodLabels(horizon: ModelDefinition["time_horizon"]): string[] {
  const labels: string[] = [];
  if (horizon.granularity === "quarterly") {
    const startMatch = horizon.start.match(/(\d{4})-Q(\d)/);
    const endMatch = horizon.end.match(/(\d{4})-Q(\d)/);
    if (!startMatch || !endMatch) return [horizon.start];
    let year = parseInt(startMatch[1], 10);
    let quarter = parseInt(startMatch[2], 10);
    const endYear = parseInt(endMatch[1], 10);
    const endQuarter = parseInt(endMatch[2], 10);
    while (year < endYear || (year === endYear && quarter <= endQuarter)) {
      labels.push(`${year}-Q${quarter}`);
      quarter++;
      if (quarter > 4) {
        quarter = 1;
        year++;
      }
    }
  } else {
    const startMatch = horizon.start.match(/(\d{4})-Q(\d)/);
    const endMatch = horizon.end.match(/(\d{4})-Q(\d)/);
    if (startMatch && endMatch) {
      let year = parseInt(startMatch[1], 10);
      let month = (parseInt(startMatch[2], 10) - 1) * 3 + 1;
      const endYear = parseInt(endMatch[1], 10);
      const endMonth = parseInt(endMatch[2], 10) * 3;
      while (year < endYear || (year === endYear && month <= endMonth)) {
        labels.push(`${year}-${String(month).padStart(2, "0")}`);
        month++;
        if (month > 12) {
          month = 1;
          year++;
        }
      }
    } else {
      const sMatch = horizon.start.match(/(\d{4})-(\d{2})/);
      const eMatch = horizon.end.match(/(\d{4})-(\d{2})/);
      if (sMatch && eMatch) {
        let year = parseInt(sMatch[1], 10);
        let month = parseInt(sMatch[2], 10);
        const endYear = parseInt(eMatch[1], 10);
        const endMonth = parseInt(eMatch[2], 10);
        while (year < endYear || (year === endYear && month <= endMonth)) {
          labels.push(`${year}-${String(month).padStart(2, "0")}`);
          month++;
          if (month > 12) {
            month = 1;
            year++;
          }
        }
      } else {
        labels.push(horizon.start);
      }
    }
  }
  return labels.length > 0 ? labels : [horizon.start];
}

// ── CompiledModel: formula-DAG implementation ──

export class CompiledModel implements EvaluableModel {
  readonly kind = "formula" as const;
  readonly inputs: ModelInput[];
  readonly outputIds: string[];
  readonly supportsPeriods: boolean;
  private order: string[];
  private varsById: Map<string, ModelVariable>;
  private compiled: Map<string, CompiledFn>;
  private baseCtx: Record<string, number>;
  private modelDef: ModelDefinition;
  private periodLabels: string[];

  constructor(model: ModelDefinition) {
    this.modelDef = model;
    this.varsById = new Map(model.variables.map((v) => [v.id, v]));
    this.order = topologicalSort(model.variables);
    const knownIds = new Set(model.variables.map((v) => v.id));
    this.compiled = new Map();
    for (const v of model.variables) {
      this.compiled.set(v.id, compileFormula(v.formula, knownIds, v.id));
    }
    this.baseCtx = this.evaluate({});
    this.inputs = model.variables
      .filter((v) => v.dependencies.length === 0)
      .map((v) => ({
        id: v.id,
        name: v.name,
        base: this.baseCtx[v.id] ?? 0,
        metricType: v.metric_type ?? inferMetricTypeFromId(v.id, v.name),
      }));
    this.outputIds = model.variables
      .filter((v) => v.tags?.includes("pl_metric"))
      .map((v) => v.id);
    this.periodLabels = generatePeriodLabels(model.time_horizon);
    this.supportsPeriods = this.periodLabels.length > 1;
  }

  /** Expose definition for driver-tree / period-growth consumers. */
  get definition(): ModelDefinition {
    return this.modelDef;
  }

  baseValues(): Record<string, number> {
    return { ...this.baseCtx };
  }

  evaluate(absoluteOverrides: Record<string, number>): Record<string, number> {
    const ctx: Record<string, number> = {};
    for (const id of this.order) {
      if (id in absoluteOverrides && Number.isFinite(absoluteOverrides[id])) {
        ctx[id] = absoluteOverrides[id];
        continue;
      }
      const v = this.varsById.get(id);
      if (!v) continue;
      const fn = this.compiled.get(id)!;
      let val: number;
      try {
        val = fn(ctx, SAFE_FUNCTIONS);
      } catch (e) {
        if (e instanceof ExpressionError) throw e;
        throw new ExpressionError(`Formula evaluation failed: ${(e as Error).message}`, id);
      }
      if (typeof val !== "number" || !Number.isFinite(val)) {
        throw new ExpressionError(`Formula produced a non-finite value`, id);
      }
      ctx[id] = val;
    }
    return ctx;
  }

  evaluatePeriods(absoluteOverrides: Record<string, number>): PeriodSlice[] {
    const hasGrowth = this.modelDef.variables.some(
      (v) =>
        v.dependencies.length === 0 &&
        v.period_growth_pct != null &&
        Number.isFinite(v.period_growth_pct) &&
        v.period_growth_pct !== 0,
    );

    return this.periodLabels.map((period, t) => {
      let abs = absoluteOverrides;
      if (hasGrowth) {
        abs = { ...absoluteOverrides };
        for (const v of this.modelDef.variables) {
          if (v.dependencies.length > 0) continue;
          if (v.period_growth_pct == null || !Number.isFinite(v.period_growth_pct) || v.period_growth_pct === 0) {
            continue;
          }
          const mt = v.metric_type ?? inferMetricTypeFromId(v.id, v.name);
          if (mt === "percent" || mt === "ratio") continue;
          const base = absoluteOverrides[v.id] ?? this.baseCtx[v.id];
          if (base == null || !Number.isFinite(base)) continue;
          abs[v.id] = base * Math.pow(1 + v.period_growth_pct / 100, t);
        }
      }
      return { period, values: this.evaluate(abs) };
    });
  }
}
