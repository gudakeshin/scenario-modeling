/**
 * Native multidimensional calculation engine.
 * Sparse leaf cells + lazy hierarchy aggregation; flat (0-dim) degenerates to CompiledModel.
 */

import {
  compileFormula,
  topologicalSort,
  ExpressionError,
  type EvaluableModel,
  type ModelInput,
} from "./expression.js";
import { inferMetricTypeFromId, isRatioLike, resolveMetricType } from "./metricTypes.js";
import {
  makeCellKey,
  splitCellKey,
  type CellKey,
  type DimensionalEvalResult,
  type DimensionalModelDefinition,
  type DimensionalOverride,
  type DimensionalVariable,
  type Dimension,
  type Member,
  type AggregationKind,
} from "../models/dimensions.js";
import type { MetricType } from "./metricTypes.js";

type CompiledFn = (ctx: Record<string, number>, fns: typeof SAFE_FNS) => number;

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

interface DimIndex {
  dim: Dimension;
  byId: Map<string, Member>;
  children: Map<string | null, Member[]>;
  leaves: Member[];
}

function buildDimIndex(dim: Dimension): DimIndex {
  const parentIds = new Set(
    dim.members.map((m) => m.parentId).filter((id): id is string => id != null),
  );
  const members = dim.members.map((m) => ({ ...m, isLeaf: !parentIds.has(m.id) }));
  const indexedDim = { ...dim, members };
  const byId = new Map(members.map((m) => [m.id, m]));
  const children = new Map<string | null, Member[]>();
  for (const m of members) {
    const p = m.parentId;
    if (!children.has(p)) children.set(p, []);
    children.get(p)!.push(m);
  }
  return {
    dim: indexedDim,
    byId,
    children,
    leaves: members.filter((m) => m.isLeaf),
  };
}

function leafDescendants(idx: DimIndex, memberId: string): string[] {
  const m = idx.byId.get(memberId);
  if (!m) throw new ExpressionError(`Unknown member '${memberId}' on dimension '${idx.dim.id}'`);
  if (m.isLeaf) return [m.id];
  const out: string[] = [];
  const stack = [...(idx.children.get(m.id) ?? [])];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur.isLeaf) out.push(cur.id);
    else stack.push(...(idx.children.get(cur.id) ?? []));
  }
  return out;
}

function allLeafKeys(dimIds: string[], indexes: Map<string, DimIndex>): CellKey[] {
  if (dimIds.length === 0) return [""];
  let keys: string[][] = [[]];
  for (const d of dimIds) {
    const idx = indexes.get(d)!;
    const next: string[][] = [];
    for (const prefix of keys) {
      for (const leaf of idx.leaves) {
        next.push([...prefix, leaf.id]);
      }
    }
    keys = next;
  }
  return keys.map((p) => makeCellKey(p));
}

export class DimensionalModel implements EvaluableModel {
  readonly kind = "dimensional" as const;
  readonly inputs: ModelInput[];
  readonly outputIds: string[];

  private def: DimensionalModelDefinition;
  private order: string[];
  private varsById: Map<string, DimensionalVariable>;
  private compiled: Map<string, CompiledFn>;
  private dimIndexes: Map<string, DimIndex>;
  /** Base leaf cells: variableId → cellKey → value */
  private baseLeaves: Map<string, Map<CellKey, number>>;
  private baseTotals: Record<string, number>;
  private buildWarnings: string[];

  constructor(
    def: DimensionalModelDefinition,
    /** Optional preloaded leaf facts: measureId → cellKey → value */
    leafFacts?: Map<string, Map<CellKey, number>>,
  ) {
    this.def = def;
    this.buildWarnings = [...(def.build_warnings ?? [])];
    this.varsById = new Map(def.variables.map((v) => [v.id, v]));
    this.order = topologicalSort(def.variables);
    this.dimIndexes = new Map(def.dimensions.map((d) => [d.id, buildDimIndex(d)]));

    const knownIds = new Set(def.variables.map((v) => v.id));
    this.compiled = new Map();
    for (const v of def.variables) {
      if (v.formula != null && v.formula !== "" && v.dependencies.length > 0) {
        this.compiled.set(v.id, compileFormula(v.formula, knownIds, v.id));
      }
    }

    this.baseLeaves = new Map();
    if (leafFacts) {
      for (const [id, cells] of leafFacts) {
        this.baseLeaves.set(id, new Map(cells));
      }
    }

    // Materialize input leaves from formula constants when no facts provided
    for (const v of def.variables) {
      if (v.dependencies.length === 0) {
        if (!this.baseLeaves.has(v.id)) {
          const cells = new Map<CellKey, number>();
          const formula = v.formula?.trim() ?? "0";
          const num = Number(formula);
          const baseVal = Number.isFinite(num) ? num : 0;
          if (v.dims.length === 0) {
            cells.set("", baseVal);
          } else if (!leafFacts) {
            // Scalar constant broadcast to all leaf combos only when no facts
            for (const key of allLeafKeys(v.dims, this.dimIndexes)) {
              cells.set(key, baseVal);
            }
          }
          this.baseLeaves.set(v.id, cells);
        }
      }
    }

    // Validate dim references
    for (const v of def.variables) {
      for (const d of v.dims) {
        if (!this.dimIndexes.has(d)) {
          throw new ExpressionError(`Variable '${v.id}' references unknown dimension '${d}'`, v.id);
        }
      }
    }

    this.baseTotals = this.evaluate({});
    this.inputs = def.variables
      .filter((v) => v.dependencies.length === 0)
      .map((v) => ({
        id: v.id,
        name: v.name,
        base: this.baseTotals[v.id] ?? 0,
        metricType: v.metric_type ?? inferMetricTypeFromId(v.id, v.name),
      }));
    this.outputIds = def.variables
      .filter((v) => v.tags?.includes("pl_metric"))
      .map((v) => v.id);
  }

  get warnings(): string[] {
    return this.buildWarnings;
  }

  get definition(): DimensionalModelDefinition {
    return this.def;
  }

  baseValues(): Record<string, number> {
    return { ...this.baseTotals };
  }

  /**
   * EvaluableModel contract — returns all-Total aggregates.
   * Flat absolute overrides scale leaf cells proportionally (or set scalar).
   */
  evaluate(absoluteOverrides: Record<string, number>): Record<string, number> {
    const dimOverrides: DimensionalOverride[] = [];
    for (const [variableId, value] of Object.entries(absoluteOverrides)) {
      if (!Number.isFinite(value)) continue;
      dimOverrides.push({
        variableId,
        value,
        delta_type: "absolute",
      });
    }
    return this.evaluateDimensional(dimOverrides).totals;
  }

  /**
   * Period-aware evaluation via the time dimension leaves (when configured).
   * Falls back to a single "Total" slice from evaluate().
   */
  get supportsPeriods(): boolean {
    return !!this.def.time_dimension_id && this.dimIndexes.has(this.def.time_dimension_id);
  }

  evaluatePeriods(absoluteOverrides: Record<string, number>): import("./expression.js").PeriodSlice[] {
    const timeDimId = this.def.time_dimension_id;
    if (!timeDimId || !this.dimIndexes.has(timeDimId)) {
      return [{ period: "Total", values: this.evaluate(absoluteOverrides) }];
    }

    const dimOverrides: DimensionalOverride[] = [];
    for (const [variableId, value] of Object.entries(absoluteOverrides)) {
      if (!Number.isFinite(value)) continue;
      dimOverrides.push({
        variableId,
        value,
        delta_type: "absolute",
      });
    }
    const result = this.evaluateDimensional(dimOverrides);
    const timeIdx = this.dimIndexes.get(timeDimId)!;
    const leaves = [...timeIdx.leaves].sort((a, b) => a.ordinal - b.ordinal);
    if (leaves.length === 0) {
      return [{ period: "Total", values: result.totals }];
    }

    return leaves.map((leaf) => {
      const values: Record<string, number> = {};
      for (const id of this.outputIds) {
        const v = result.valueAt(id, { [timeDimId]: leaf.id });
        if (v !== undefined && Number.isFinite(v)) values[id] = v;
      }
      // Also include input totals at that POV when available
      for (const input of this.inputs) {
        const v = result.valueAt(input.id, { [timeDimId]: leaf.id });
        if (v !== undefined && Number.isFinite(v)) values[input.id] = v;
      }
      return { period: leaf.name, values };
    });
  }

  evaluateDimensional(overrides: DimensionalOverride[]): DimensionalEvalResult {
    // Per-pass leaf stores + rollup memo
    const leaves = new Map<string, Map<CellKey, number>>();
    for (const [id, cells] of this.baseLeaves) {
      leaves.set(id, new Map(cells));
    }

    // Apply overrides to input variables first (pin before dependents)
    const overrideByVar = new Map<string, DimensionalOverride[]>();
    for (const o of overrides) {
      if (!overrideByVar.has(o.variableId)) overrideByVar.set(o.variableId, []);
      overrideByVar.get(o.variableId)!.push(o);
    }

    const rollupMemo = new Map<string, number>(); // `${varId}::${povKey}`

    const getLeafMap = (varId: string): Map<CellKey, number> => {
      let m = leaves.get(varId);
      if (!m) {
        m = new Map();
        leaves.set(varId, m);
      }
      return m;
    };

    // Pin input overrides
    for (const v of this.def.variables) {
      if (v.dependencies.length > 0) continue;
      const ovList = overrideByVar.get(v.id);
      if (!ovList) continue;
      for (const ov of ovList) {
        this.applyOverrideToLeaves(v, getLeafMap(v.id), ov);
      }
    }

    // Evaluate in topo order
    for (const id of this.order) {
      const v = this.varsById.get(id)!;
      if (v.dependencies.length === 0) continue;

      const resultDims = this.resultDims(v);
      const cellKeys = this.sparseCellKeys(v, leaves);
      const out = getLeafMap(id);
      out.clear();

      const fn = this.compiled.get(id);
      if (!fn) {
        // No formula — leave empty (or copy if single dep with same dims)
        continue;
      }

      for (const key of cellKeys) {
        const parts = splitCellKey(key);
        const ctx: Record<string, number> = {};
        let skip = false;
        for (const depId of v.dependencies) {
          const dep = this.varsById.get(depId);
          if (!dep) {
            throw new ExpressionError(`Unknown dependency '${depId}'`, id);
          }
          const val = this.readAt(depId, dep, parts, resultDims, leaves, rollupMemo);
          if (val === undefined) {
            skip = true;
            break;
          }
          ctx[depId] = val;
        }
        if (skip) continue;
        let val: number;
        try {
          val = fn(ctx, SAFE_FNS);
        } catch (e) {
          if (e instanceof ExpressionError) throw e;
          throw new ExpressionError(`Formula evaluation failed: ${(e as Error).message}`, id);
        }
        if (typeof val !== "number" || !Number.isFinite(val)) {
          throw new ExpressionError("Formula produced a non-finite value", id);
        }
        out.set(key === "" && resultDims.length > 0 ? makeCellKey(parts) : key, val);
      }

      // Apply overrides on calculated vars (rare but supported)
      const ovList = overrideByVar.get(id);
      if (ovList) {
        for (const ov of ovList) {
          this.applyOverrideToLeaves(v, out, ov);
        }
      }
    }

    // Totals in topo order so ratio metrics can recompute from rolled-up deps
    const totals: Record<string, number> = {};
    for (const id of this.order) {
      const v = this.varsById.get(id)!;
      const mt = resolveMetricType(v.metric_type, v.id, v.name);
      const fn = this.compiled.get(id);
      if (isRatioLike(mt) && fn && v.dependencies.length > 0) {
        const ctx: Record<string, number> = {};
        let ok = true;
        for (const depId of v.dependencies) {
          if (totals[depId] === undefined || !Number.isFinite(totals[depId])) {
            ok = false;
            break;
          }
          ctx[depId] = totals[depId];
        }
        if (ok) {
          try {
            const recomputed = fn(ctx, SAFE_FNS);
            if (typeof recomputed === "number" && Number.isFinite(recomputed)) {
              totals[id] = recomputed;
              continue;
            }
          } catch {
            /* fall through to leaf rollup */
          }
        }
      }
      const t = this.aggregateAll(v, getLeafMap(v.id), rollupMemo);
      if (t !== undefined) totals[id] = t;
    }

    return {
      totals,
      valueAt: (variableId: string, pov: Record<string, string>) => {
        const v = this.varsById.get(variableId);
        if (!v) return undefined;
        rollupMemo.clear(); // POV reads use same leaf store
        return this.readPov(v, pov, getLeafMap(variableId), rollupMemo);
      },
    };
  }

  private resultDims(v: DimensionalVariable): string[] {
    // Union of dependency dim sets, preserving order from first dep then extras
    const seen = new Set<string>();
    const dims: string[] = [];
    for (const depId of v.dependencies) {
      const dep = this.varsById.get(depId);
      if (!dep) continue;
      for (const d of dep.dims) {
        if (!seen.has(d)) {
          seen.add(d);
          dims.push(d);
        }
      }
    }
    // If variable declares dims explicitly and deps are empty somehow
    if (dims.length === 0 && v.dims.length > 0) return [...v.dims];
    return dims.length > 0 ? dims : [...v.dims];
  }

  private sparseCellKeys(
    v: DimensionalVariable,
    leaves: Map<string, Map<CellKey, number>>,
  ): CellKey[] {
    const resultDims = this.resultDims(v);
    if (resultDims.length === 0) return [""];

    const keySet = new Set<CellKey>();
    for (const depId of v.dependencies) {
      const dep = this.varsById.get(depId);
      if (!dep) continue;
      const depLeaves = leaves.get(depId);
      if (!depLeaves) continue;
      for (const depKey of depLeaves.keys()) {
        const depParts = splitCellKey(depKey);
        // Map dep cell into result dim coordinates
        const resultParts: string[] = [];
        let ok = true;
        for (const d of resultDims) {
          const di = dep.dims.indexOf(d);
          if (di >= 0) {
            resultParts.push(depParts[di] ?? "");
          } else {
            // Dep lacks this dim — will broadcast; need all leaves of this dim
            ok = false;
            break;
          }
        }
        if (ok) {
          keySet.add(makeCellKey(resultParts));
        } else {
          // Expand missing dims from this dep's perspective: use cartesian of missing
          // Simpler approach: start from dep key and expand
          this.expandKeyToResultDims(dep, depParts, resultDims, keySet);
        }
      }
    }

    // Also handle case where one dep is scalar
    if (keySet.size === 0) {
      // fallback: union of all dep leaf keys projected
      for (const depId of v.dependencies) {
        const dep = this.varsById.get(depId);
        const depLeaves = leaves.get(depId);
        if (!dep || !depLeaves) continue;
        if (dep.dims.length === 0) {
          for (const k of allLeafKeys(resultDims, this.dimIndexes)) keySet.add(k);
        }
      }
    }

    return [...keySet];
  }

  private expandKeyToResultDims(
    dep: DimensionalVariable,
    depParts: string[],
    resultDims: string[],
    keySet: Set<CellKey>,
  ): void {
    let prefixes: string[][] = [[]];
    for (const d of resultDims) {
      const di = dep.dims.indexOf(d);
      const next: string[][] = [];
      if (di >= 0) {
        for (const p of prefixes) next.push([...p, depParts[di]]);
      } else {
        const idx = this.dimIndexes.get(d)!;
        for (const p of prefixes) {
          for (const leaf of idx.leaves) next.push([...p, leaf.id]);
        }
      }
      prefixes = next;
    }
    for (const p of prefixes) keySet.add(makeCellKey(p));
  }

  private readAt(
    depId: string,
    dep: DimensionalVariable,
    resultParts: string[],
    resultDims: string[],
    leaves: Map<string, Map<CellKey, number>>,
    rollupMemo: Map<string, number>,
  ): number | undefined {
    if (dep.dims.length === 0) {
      return leaves.get(depId)?.get("");
    }

    // Build POV for dep dims from resultParts
    const pov: Record<string, string> = {};
    for (const d of dep.dims) {
      const ri = resultDims.indexOf(d);
      if (ri >= 0) {
        pov[d] = resultParts[ri];
      } else {
        // Dep has extra dim — read at Total (aggregate all leaves)
        // leave unset → aggregate over that dim
        if (!this.buildWarnings.some((w) => w.includes(depId) && w.includes(d))) {
          this.buildWarnings.push(
            `Dependency '${depId}' has extra dimension '${d}' — reading at Total`,
          );
        }
      }
    }
    return this.readPov(dep, pov, leaves.get(depId) ?? new Map(), rollupMemo, depId);
  }

  private readPov(
    v: DimensionalVariable,
    pov: Record<string, string>,
    leafMap: Map<CellKey, number>,
    rollupMemo: Map<string, number>,
    memoVarId?: string,
  ): number | undefined {
    const varId = memoVarId ?? v.id;
    if (v.dims.length === 0) return leafMap.get("");

    // Resolve each dim in v.dims to a member (or aggregate)
    const resolved: Array<{ dimId: string; memberId: string | null }> = [];
    for (const d of v.dims) {
      resolved.push({ dimId: d, memberId: pov[d] ?? null });
    }

    const memoKey = `${varId}::${resolved.map((r) => `${r.dimId}=${r.memberId ?? "*"}`).join(",")}`;
    if (rollupMemo.has(memoKey)) return rollupMemo.get(memoKey);

    const val = this.aggregateRecursive(v, resolved, 0, [], leafMap, rollupMemo, varId);
    if (val !== undefined) rollupMemo.set(memoKey, val);
    return val;
  }

  private aggregateRecursive(
    v: DimensionalVariable,
    resolved: Array<{ dimId: string; memberId: string | null }>,
    depth: number,
    prefix: string[],
    leafMap: Map<CellKey, number>,
    rollupMemo: Map<string, number>,
    varId: string,
  ): number | undefined {
    if (depth === resolved.length) {
      const key = makeCellKey(prefix);
      return leafMap.get(key);
    }

    const { dimId, memberId } = resolved[depth];
    const idx = this.dimIndexes.get(dimId)!;

    if (memberId == null) {
      // Aggregate all root children / all leaves via hierarchy roots
      const roots = idx.dim.members.filter((m) => !m.parentId);
      const targets = roots.length > 0 ? roots : idx.leaves;
      const mt = resolveMetricType(v.metric_type, v.id, v.name);
      return this.combine(
        v.aggregation,
        targets.map((m) => {
          const next = [...resolved];
          next[depth] = { dimId, memberId: m.id };
          return this.aggregateRecursive(v, next, depth, prefix, leafMap, rollupMemo, varId);
        }),
        targets,
        mt,
      );
    }

    const member = idx.byId.get(memberId);
    if (!member) {
      throw new ExpressionError(`Unknown member '${memberId}' on '${dimId}'`, varId);
    }

    if (member.isLeaf) {
      return this.aggregateRecursive(
        v,
        resolved,
        depth + 1,
        [...prefix, member.id],
        leafMap,
        rollupMemo,
        varId,
      );
    }

    // Non-leaf: aggregate children
    const kids = idx.children.get(member.id) ?? [];
    const mt = resolveMetricType(v.metric_type, v.id, v.name);
    return this.combine(
      v.aggregation,
      kids.map((child) => {
        const next = [...resolved];
        next[depth] = { dimId, memberId: child.id };
        return this.aggregateRecursive(v, next, depth, prefix, leafMap, rollupMemo, varId);
      }),
      kids,
      mt,
    );
  }

  private combine(
    agg: AggregationKind,
    values: Array<number | undefined>,
    members: Member[],
    metricType: MetricType = "unknown",
  ): number | undefined {
    const present: Array<{ v: number; sign: 1 | -1 }> = [];
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (v === undefined) continue;
      present.push({ v, sign: members[i]?.sign ?? 1 });
    }
    if (present.length === 0) return undefined;

    // Never sum/signed_sum percent or ratio metrics (avoids 160% margin artifacts)
    if (isRatioLike(metricType)) {
      return present.reduce((s, p) => s + p.v, 0) / present.length;
    }

    switch (agg) {
      case "signed_sum":
        return present.reduce((s, p) => s + p.sign * p.v, 0);
      case "avg":
        return present.reduce((s, p) => s + p.v, 0) / present.length;
      case "last":
        return present[present.length - 1].v;
      case "sum":
      default:
        return present.reduce((s, p) => s + p.v, 0);
    }
  }

  private aggregateAll(
    v: DimensionalVariable,
    leafMap: Map<CellKey, number>,
    rollupMemo: Map<string, number>,
  ): number | undefined {
    if (v.dims.length === 0) return leafMap.get("");
    return this.readPov(v, {}, leafMap, rollupMemo);
  }

  private applyOverrideToLeaves(
    v: DimensionalVariable,
    leafMap: Map<CellKey, number>,
    ov: DimensionalOverride,
  ): void {
    const scope = ov.memberScope ?? {};

    // Collect affected leaf keys
    let candidateKeys = [...leafMap.keys()];
    if (candidateKeys.length === 0 && v.dims.length > 0) {
      candidateKeys = allLeafKeys(v.dims, this.dimIndexes);
    } else if (candidateKeys.length === 0) {
      candidateKeys = [""];
    }

    const matching: CellKey[] = [];
    for (const key of candidateKeys) {
      const parts = splitCellKey(key);
      let ok = true;
      for (let i = 0; i < v.dims.length; i++) {
        const dimId = v.dims[i];
        const scoped = scope[dimId];
        if (!scoped) continue;
        const idx = this.dimIndexes.get(dimId)!;
        const leaves = new Set(leafDescendants(idx, scoped));
        if (!leaves.has(parts[i])) {
          ok = false;
          break;
        }
      }
      // Also include keys not yet in map if scope expands
      if (ok) matching.push(key);
    }

    // If scope references members but leafMap sparse, expand from scope
    if (Object.keys(scope).length > 0 && matching.length === 0 && v.dims.length > 0) {
      const expanded = allLeafKeys(v.dims, this.dimIndexes).filter((key) => {
        const parts = splitCellKey(key);
        return v.dims.every((dimId, i) => {
          const scoped = scope[dimId];
          if (!scoped) return true;
          const idx = this.dimIndexes.get(dimId)!;
          return leafDescendants(idx, scoped).includes(parts[i]);
        });
      });
      matching.push(...expanded);
    }

    if (matching.length === 0 && v.dims.length === 0) {
      matching.push("");
    }

    if (ov.delta_type === "percent") {
      for (const key of matching) {
        const cur = leafMap.get(key) ?? 0;
        leafMap.set(key, cur * (1 + ov.value / 100));
      }
      return;
    }

    if (ov.delta_type === "additive") {
      if (matching.length === 0) return;
      const currentAggregate = this.readPov(v, scope, leafMap, new Map()) ?? 0;
      if (Math.abs(currentAggregate) < 1e-12) {
        const each = ov.value / matching.length;
        for (const key of matching) {
          leafMap.set(key, (leafMap.get(key) ?? 0) + each);
        }
      } else {
        for (const key of matching) {
          const cur = leafMap.get(key) ?? 0;
          leafMap.set(key, cur + ov.value * (cur / currentAggregate));
        }
      }
      return;
    }

    // Absolute: set scoped aggregate with proportional scaling
    if (matching.length === 0) return;
    const currentAggregate = this.readPov(v, scope, leafMap, new Map()) ?? 0;

    if (Math.abs(currentAggregate) < 1e-12) {
      const each = ov.value / matching.length;
      for (const key of matching) leafMap.set(key, each);
    } else {
      const factor = ov.value / currentAggregate;
      for (const key of matching) {
        leafMap.set(key, (leafMap.get(key) ?? 0) * factor);
      }
    }
  }
}

/** Build leaf fact map from DB-style rows. */
export function factsToLeafMap(
  rows: Array<{ measure_id: string; member_key: string; value: number }>,
): Map<string, Map<CellKey, number>> {
  const out = new Map<string, Map<CellKey, number>>();
  for (const row of rows) {
    let m = out.get(row.measure_id);
    if (!m) {
      m = new Map();
      out.set(row.measure_id, m);
    }
    m.set(row.member_key, Number(row.value));
  }
  return out;
}
