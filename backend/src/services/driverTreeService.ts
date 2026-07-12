/**
 * Driver tree — nested decomposition of a target metric into its inputs.
 *
 * Formula models: nest by ModelDefinition dependencies.
 * Dimensional models: nest members with rolled-up values.
 * XLSX models: nest by workbook formula lineage (cell dependency graph) when available.
 */

import { pool } from "../db/index.js";
import type { EvaluableModel } from "./expression.js";
import { CompiledModel } from "./expression.js";
import { DimensionalModel } from "./dimensionalModel.js";
import type { WorkbookGraph, WorkbookDependency } from "./excelExtractor.js";
import type { XlsxModelSchemaLike } from "./xlsxRuntime.js";
import { XlsxModelRuntime } from "./xlsxRuntime.js";
import {
  getEvaluableModelForScenario,
  loadScenarioOverrides,
  resolveOverridesToAbsolute,
  type ResolvedModel,
} from "./modelResolver.js";

export interface DriverTreeNode {
  id: string;
  name: string;
  value: number;
  /** True when this node is an editable scenario lever (input). */
  editable?: boolean;
  children?: DriverTreeNode[];
}

export interface DriverTreeResult {
  target_metric: string;
  root: DriverTreeNode;
  model_kind: EvaluableModel["kind"];
  /** How to apply lever edits (documented apply path). */
  apply_path?: string;
}

export interface ApplyLeverResult {
  parameter_id: string;
  mapped_variable_id: string;
  scenario_value: number;
  delta_type: string;
  status: string;
  created: boolean;
}

class DriverTreeError extends Error {
  status = 422;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function toId(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function normalizeCellRef(ref: string): string {
  return ref.replace(/\$/g, "").replace(/^'([^']+)'!/, "$1!").trim();
}

function buildFormulaTree(
  model: CompiledModel,
  values: Record<string, number>,
  metricId: string,
  inputIds: Set<string>,
  visiting = new Set<string>(),
): DriverTreeNode {
  if (visiting.has(metricId)) {
    return {
      id: metricId,
      name: metricId,
      value: round2(values[metricId] ?? 0),
      editable: inputIds.has(metricId),
    };
  }
  visiting.add(metricId);
  const def = model.definition;
  const variable = def.variables.find((v) => v.id === metricId);
  const name = variable?.name ?? metricId;
  const value = round2(values[metricId] ?? 0);
  const deps = variable?.dependencies ?? [];
  const children =
    deps.length > 0
      ? deps.map((d) => buildFormulaTree(model, values, d, inputIds, visiting))
      : undefined;
  visiting.delete(metricId);
  return {
    id: metricId,
    name,
    value,
    editable: inputIds.has(metricId),
    ...(children ? { children } : {}),
  };
}

function buildDimensionalTree(
  model: DimensionalModel,
  metricId: string,
  values: Record<string, number>,
  inputIds: Set<string>,
): DriverTreeNode {
  const def = model.definition;
  const variable = def.variables.find((v) => v.id === metricId);
  const name = variable?.name ?? metricId;
  const rootValue = round2(values[metricId] ?? 0);

  const children: DriverTreeNode[] = [];

  for (const depId of variable?.dependencies ?? []) {
    const depVar = def.variables.find((v) => v.id === depId);
    children.push({
      id: depId,
      name: depVar?.name ?? depId,
      value: round2(values[depId] ?? 0),
      editable: inputIds.has(depId),
    });
  }

  if (variable && variable.dims.length > 0) {
    for (const dimId of variable.dims) {
      const dim = def.dimensions.find((d) => d.id === dimId);
      if (!dim) continue;
      const memberNodes: DriverTreeNode[] = [];
      for (const member of dim.members.filter((m) => m.parentId == null || !dim.members.some((p) => p.id === m.parentId))) {
        let memberVal = 0;
        try {
          const result = model.evaluateDimensional([]);
          memberVal = result.valueAt(metricId, { [dimId]: member.id }) ?? 0;
        } catch {
          memberVal = 0;
        }
        const childMembers = dim.members.filter((m) => m.parentId === member.id);
        const nested: DriverTreeNode[] = childMembers.map((cm) => {
          let cv = 0;
          try {
            cv = model.evaluateDimensional([]).valueAt(metricId, { [dimId]: cm.id }) ?? 0;
          } catch {
            cv = 0;
          }
          return { id: `${metricId}:${dimId}:${cm.id}`, name: cm.name || cm.id, value: round2(cv) };
        });
        memberNodes.push({
          id: `${metricId}:${dimId}:${member.id}`,
          name: member.name || member.id,
          value: round2(memberVal),
          ...(nested.length > 0 ? { children: nested } : {}),
        });
      }
      if (memberNodes.length > 0) {
        children.push({
          id: `${metricId}:dim:${dimId}`,
          name: dim.name || dimId,
          value: rootValue,
          children: memberNodes,
        });
      }
    }
  }

  return {
    id: metricId,
    name,
    value: rootValue,
    ...(children.length > 0 ? { children } : {}),
  };
}

/**
 * Build XLSX driver tree from workbook formula dependencies.
 * Walks readsFrom edges from the target output cell back toward input levers.
 */
function buildXlsxLineageTree(
  graph: WorkbookGraph,
  schema: XlsxModelSchemaLike | undefined,
  values: Record<string, number>,
  model: EvaluableModel,
  targetMetric: string,
): DriverTreeNode {
  const inputIds = new Set(model.inputs.map((i) => i.id));
  const outputById = new Map(
    (schema?.outputMetrics || []).map((m) => [toId(m.id), m]),
  );
  const leverByCell = new Map<string, { id: string; label: string }>();
  for (const lever of schema?.scenarioLevers || []) {
    const id = toId(lever.id);
    const sheet = lever.sheet;
    const cell = lever.cell;
    if (sheet && cell) {
      leverByCell.set(normalizeCellRef(`${sheet}!${cell}`), {
        id,
        label: lever.label || lever.id,
      });
    }
  }
  for (const cand of graph.inputCandidates || []) {
    const id = toId(cand.id || cand.label || "");
    if (!id || !cand.sheet || !cand.cell) continue;
    const key = normalizeCellRef(`${cand.sheet}!${cand.cell}`);
    if (!leverByCell.has(key)) {
      leverByCell.set(key, { id, label: cand.label || id });
    }
  }

  const depByFrom = new Map<string, WorkbookDependency>();
  for (const dep of graph.dependencies || []) {
    depByFrom.set(normalizeCellRef(dep.from), dep);
  }

  const targetMeta = outputById.get(toId(targetMetric));
  const targetCand = (graph.outputCandidates || []).find(
    (c) => toId(c.id || c.label || "") === toId(targetMetric),
  );
  const targetSheet = targetMeta?.sheet || targetCand?.sheet;
  const targetCell = targetMeta?.cell || targetCand?.cell;
  const rootValue = round2(values[targetMetric] ?? values[toId(targetMetric)] ?? 0);

  if (!targetSheet || !targetCell) {
    // Fallback: flat inputs
    return {
      id: targetMetric,
      name: targetMetric,
      value: rootValue,
      children: model.inputs.map((i) => ({
        id: i.id,
        name: i.name,
        value: round2(values[i.id] ?? i.base),
        editable: true,
      })),
    };
  }

  const rootRef = normalizeCellRef(`${targetSheet}!${targetCell}`);

  function walk(cellRef: string, visiting: Set<string>): DriverTreeNode {
    const norm = normalizeCellRef(cellRef);
    const lever = leverByCell.get(norm);
    if (lever) {
      return {
        id: lever.id,
        name: lever.label,
        value: round2(values[lever.id] ?? 0),
        editable: inputIds.has(lever.id),
      };
    }

    if (visiting.has(norm)) {
      return { id: norm, name: norm, value: 0 };
    }
    visiting.add(norm);

    const dep = depByFrom.get(norm);
    const children: DriverTreeNode[] = [];
    if (dep?.readsFrom?.length) {
      for (const from of dep.readsFrom) {
        children.push(walk(from, visiting));
      }
    }
    visiting.delete(norm);

    // Prefer metric id when this cell matches an output candidate
    const outMatch = (graph.outputCandidates || []).find(
      (c) => c.sheet && c.cell && normalizeCellRef(`${c.sheet}!${c.cell}`) === norm,
    );
    const id = outMatch ? toId(outMatch.id || outMatch.label || norm) : norm;
    const name = outMatch?.label || id;
    const value = round2(values[id] ?? (id === toId(targetMetric) ? rootValue : 0));

    return {
      id,
      name,
      value,
      editable: inputIds.has(id),
      ...(children.length > 0 ? { children } : {}),
    };
  }

  return walk(rootRef, new Set());
}

/**
 * Pure driver-tree builder. Exported for tests / reuse.
 */
export function buildDriverTree(
  model: EvaluableModel,
  scenarioAbs: Record<string, number>,
  targetMetric = "net_income",
  opts?: {
    workbookGraph?: WorkbookGraph | null;
    modelSchema?: XlsxModelSchemaLike;
  },
): DriverTreeResult {
  const values = model.evaluate(scenarioAbs);
  if (!(targetMetric in values) && !model.outputIds.includes(targetMetric)) {
    if (!(targetMetric in values)) {
      throw new DriverTreeError(
        `Unknown target metric '${targetMetric}'. Available: ${model.outputIds.join(", ")}`,
      );
    }
  }

  const inputIds = new Set(model.inputs.map((i) => i.id));
  const applyPath =
    "POST /api/v1/scenarios/:id/parameters/apply-lever { variable_id, scenario_value, delta_type? }";

  if (model.kind === "formula" && model instanceof CompiledModel) {
    return {
      target_metric: targetMetric,
      root: buildFormulaTree(model, values, targetMetric, inputIds),
      model_kind: "formula",
      apply_path: applyPath,
    };
  }

  if (model.kind === "dimensional" && model instanceof DimensionalModel) {
    return {
      target_metric: targetMetric,
      root: buildDimensionalTree(model, targetMetric, values, inputIds),
      model_kind: "dimensional",
      apply_path: applyPath,
    };
  }

  // XLSX: formula lineage when graph available
  if (
    (model.kind === "xlsx" || model instanceof XlsxModelRuntime) &&
    opts?.workbookGraph?.dependencies?.length
  ) {
    return {
      target_metric: targetMetric,
      root: buildXlsxLineageTree(
        opts.workbookGraph,
        opts.modelSchema,
        values,
        model,
        targetMetric,
      ),
      model_kind: model.kind,
      apply_path: applyPath,
    };
  }

  // XLSX / fallback: flat list of inputs under the metric
  const root: DriverTreeNode = {
    id: targetMetric,
    name: targetMetric,
    value: round2(values[targetMetric] ?? 0),
    children: model.inputs.map((i) => ({
      id: i.id,
      name: i.name,
      value: round2(values[i.id] ?? i.base),
      editable: true,
    })),
  };
  return { target_metric: targetMetric, root, model_kind: model.kind, apply_path: applyPath };
}

export async function runDriverTree(
  scenarioId: string,
  targetMetric = "net_income",
): Promise<DriverTreeResult> {
  const resolved: ResolvedModel = await getEvaluableModelForScenario(scenarioId);
  const model = resolved.model;
  const overrides = await loadScenarioOverrides(scenarioId);
  const { absolute: scenarioAbs } = resolveOverridesToAbsolute(model, overrides);

  let workbookGraph: WorkbookGraph | null = null;
  if (resolved.documentId) {
    const g = await pool.query(
      "SELECT workbook_graph FROM documents WHERE document_id = $1",
      [resolved.documentId],
    );
    workbookGraph = (g.rows[0]?.workbook_graph as WorkbookGraph) ?? null;
  }

  return buildDriverTree(model, scenarioAbs, targetMetric, {
    workbookGraph,
    modelSchema: resolved.modelSchema,
  });
}

/**
 * Upsert a scenario parameter for an input lever (goal-seek apply / driver-tree edit).
 * Creates a pending absolute override when no parameter exists yet.
 */
export async function applyLeverValue(
  scenarioId: string,
  variableId: string,
  scenarioValue: number,
  opts?: { delta_type?: "percent" | "absolute"; reason?: string; status?: string },
): Promise<ApplyLeverResult> {
  if (!Number.isFinite(scenarioValue)) {
    throw new DriverTreeError("scenario_value must be a finite number");
  }
  const resolved = await getEvaluableModelForScenario(scenarioId);
  const input = resolved.model.inputs.find((i) => i.id === variableId);
  if (!input && !resolved.model.outputIds.includes(variableId)) {
    // Allow any mapped id that appears on the model; warn if unknown
    const known = new Set([
      ...resolved.model.inputs.map((i) => i.id),
      ...resolved.model.outputIds,
    ]);
    if (!known.has(variableId)) {
      throw new DriverTreeError(
        `Unknown variable '${variableId}'. Available inputs: ${resolved.model.inputs.map((i) => i.id).join(", ")}`,
      );
    }
  }

  const deltaType = opts?.delta_type ?? "absolute";
  const status = opts?.status ?? "pending";

  const existing = await pool.query(
    `SELECT parameter_id FROM scenario_parameters
     WHERE scenario_id = $1 AND mapped_variable_id = $2
     ORDER BY created_at DESC LIMIT 1`,
    [scenarioId, variableId],
  );

  if (existing.rows.length > 0) {
    const parameterId = existing.rows[0].parameter_id as string;
    await pool.query(
      `UPDATE scenario_parameters
       SET scenario_value = $1, delta_type = $2, status = $3, is_override = TRUE,
           override_reason = COALESCE($4, override_reason)
       WHERE parameter_id = $5`,
      [scenarioValue, deltaType, status, opts?.reason ?? null, parameterId],
    );
    return {
      parameter_id: parameterId,
      mapped_variable_id: variableId,
      scenario_value: scenarioValue,
      delta_type: deltaType,
      status,
      created: false,
    };
  }

  const inserted = await pool.query(
    `INSERT INTO scenario_parameters
       (scenario_id, extracted_name, mapped_variable_id, scenario_value, delta_type, confidence_score, status, is_override, override_reason)
     VALUES ($1, $2, $3, $4, $5, 1, $6, TRUE, $7)
     RETURNING parameter_id`,
    [
      scenarioId,
      opts?.reason || `Applied lever ${variableId}`,
      variableId,
      scenarioValue,
      deltaType,
      status,
      opts?.reason ?? null,
    ],
  );

  return {
    parameter_id: inserted.rows[0].parameter_id as string,
    mapped_variable_id: variableId,
    scenario_value: scenarioValue,
    delta_type: deltaType,
    status,
    created: true,
  };
}
