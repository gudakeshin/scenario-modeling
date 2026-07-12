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

export type DeltaType = "percent" | "absolute";

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

/**
 * A model that can be evaluated with absolute input overrides.
 * Implemented by CompiledModel (formula DAG) and XlsxModelRuntime (HyperFormula).
 */
export interface EvaluableModel {
  kind: "formula" | "xlsx";
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
}

// ── CompiledModel: formula-DAG implementation ──

export class CompiledModel implements EvaluableModel {
  readonly kind = "formula" as const;
  readonly inputs: ModelInput[];
  readonly outputIds: string[];
  private order: string[];
  private varsById: Map<string, ModelVariable>;
  private compiled: Map<string, CompiledFn>;
  private baseCtx: Record<string, number>;

  constructor(model: ModelDefinition) {
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
}
