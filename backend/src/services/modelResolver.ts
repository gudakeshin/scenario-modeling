/**
 * Model Resolver — one place that answers "what model does this scenario run on?"
 *
 * Returns an EvaluableModel (formula DAG or XLSX HyperFormula runtime), so
 * simulation, Monte Carlo, and sensitivity all evaluate through the same
 * engine instead of each re-implementing model loading.
 */

import { pool } from "../db/index.js";
import { getModelDefinition } from "../models/registry.js";
import { CompiledModel, type EvaluableModel, type TypedOverride, type DeltaType } from "./expression.js";
import { getXlsxRuntime, type XlsxModelSchemaLike } from "./xlsxRuntime.js";
import type { WorkbookGraph } from "./excelExtractor.js";

export interface ResolvedModel {
  model: EvaluableModel;
  /** Where the model came from (for output metadata / debugging). */
  source: "xlsx_cell_graph" | "formula_dag";
  documentId?: string;
  modelSchema?: XlsxModelSchemaLike;
}

export class ModelResolutionError extends Error {
  status: number;
  constructor(message: string, status = 422) {
    super(message);
    this.status = status;
  }
}

interface SpreadsheetDocRow {
  document_id: string;
  updated_at: string;
  model_schema: XlsxModelSchemaLike;
  workbook_graph: WorkbookGraph | null;
  validation_status: string | null;
}

async function findSpreadsheetModelDoc(workspaceId: string): Promise<SpreadsheetDocRow | null> {
  const r = await pool.query(
    `SELECT document_id, updated_at, model_schema, workbook_graph, validation_status
     FROM documents
     WHERE workspace_id = $1
       AND status = 'ready'
       AND document_kind = 'spreadsheet_model'
       AND model_schema IS NOT NULL
     ORDER BY created_at DESC
     LIMIT 1`,
    [workspaceId],
  );
  return (r.rows[0] as SpreadsheetDocRow | undefined) ?? null;
}

export async function getEvaluableModelForScenario(scenarioId: string): Promise<ResolvedModel> {
  const scenarioRes = await pool.query(
    "SELECT creator_id, workspace_id, model_version_hash FROM scenarios WHERE scenario_id = $1",
    [scenarioId],
  );
  if (scenarioRes.rows.length === 0) throw new ModelResolutionError("Scenario not found", 404);
  const { creator_id: creatorId, workspace_id: workspaceIdRaw, model_version_hash: modelVersion } = scenarioRes.rows[0];

  // Resolve against the scenario's own workspace — never the caller's active
  // one — so shared scenarios and multi-workspace users always evaluate on
  // the document set the scenario was created from. Legacy rows (pre-backfill
  // NULL) fall back to the creator's default workspace.
  let workspaceId: string | null = workspaceIdRaw;
  if (!workspaceId) {
    const { ensureDefaultWorkspace } = await import("./workspaceService.js");
    workspaceId = await ensureDefaultWorkspace(creatorId);
  }

  const doc = await findSpreadsheetModelDoc(workspaceId);
  if (doc) {
    if (doc.validation_status !== "ready") {
      throw new ModelResolutionError(
        "Spreadsheet model is not validated yet. Please complete analyst validation before simulation.",
      );
    }
    const runtime = doc.workbook_graph
      ? getXlsxRuntime(`${doc.document_id}:${doc.updated_at}`, doc.workbook_graph, doc.model_schema)
      : null;
    if (!runtime) {
      throw new ModelResolutionError(
        "This spreadsheet was ingested before cell-level simulation was available (or is too large to snapshot). " +
          "Please re-upload the XLSX file and rebuild the model context.",
      );
    }
    return { model: runtime, source: "xlsx_cell_graph", documentId: doc.document_id, modelSchema: doc.model_schema };
  }

  const modelDef = await getModelDefinition(modelVersion);
  if (!modelDef) {
    throw new ModelResolutionError("No model found. Please build a model from your documents first.");
  }
  return { model: new CompiledModel(modelDef), source: "formula_dag" };
}

// ── Scenario overrides (typed deltas) ──

export interface ScenarioOverride extends TypedOverride {
  variableId: string;
}

export async function loadScenarioOverrides(scenarioId: string): Promise<ScenarioOverride[]> {
  const r = await pool.query(
    `SELECT mapped_variable_id, scenario_value, delta_type
     FROM scenario_parameters
     WHERE scenario_id = $1 AND status IN ('pending', 'accepted', 'modified')`,
    [scenarioId],
  );
  return r.rows.map((row: { mapped_variable_id: string; scenario_value: string; delta_type: string }) => ({
    variableId: row.mapped_variable_id,
    value: Number(row.scenario_value),
    delta_type: (row.delta_type === "percent" ? "percent" : "absolute") as DeltaType,
  }));
}

/**
 * Resolve typed overrides to ABSOLUTE input values against a model's input bases.
 * Overrides for ids the model doesn't know are returned too (callers decide);
 * percent deltas against an unknown/zero base resolve to no change and are
 * reported in `unresolved`.
 */
export function resolveOverridesToAbsolute(
  model: EvaluableModel,
  overrides: ScenarioOverride[],
): { absolute: Record<string, number>; unresolved: string[] } {
  const baseById = new Map(model.inputs.map((i) => [i.id, i.base]));
  const absolute: Record<string, number> = {};
  const unresolved: string[] = [];

  for (const o of overrides) {
    if (!Number.isFinite(o.value)) continue;
    const base = baseById.get(o.variableId);
    if (o.delta_type === "percent") {
      if (base == null || base === 0) {
        unresolved.push(o.variableId);
        continue;
      }
      absolute[o.variableId] = base * (1 + o.value / 100);
    } else {
      absolute[o.variableId] = o.value;
    }
  }
  return { absolute, unresolved };
}
