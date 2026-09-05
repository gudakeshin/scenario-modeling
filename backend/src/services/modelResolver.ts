/**
 * Model Resolver — one place that answers "what model does this scenario run on?"
 *
 * Returns an EvaluableModel (formula DAG, XLSX HyperFormula, or dimensional),
 * so simulation, Monte Carlo, and sensitivity all evaluate through the same
 * engine instead of each re-implementing model loading.
 */

import { pool } from "../db/index.js";
import { LruCache } from "../utils/lruCache.js";
import { getModelDefinition } from "../models/registry.js";
import { CompiledModel, type EvaluableModel, type TypedOverride, type DeltaType } from "./expression.js";
import { getXlsxRuntime, type XlsxModelSchemaLike } from "./xlsxRuntime.js";
import { loadBindingSchema } from "./modelBindingService.js";
import type { WorkbookGraph } from "./excelExtractor.js";
import { DimensionalModel, factsToLeafMap } from "./dimensionalModel.js";
import { sha256, stableStringify } from "../utils/hashChain.js";
import {
  isDimensionalModelDefinition,
  type DimensionalModelDefinition,
  type DimensionalOverride,
} from "../models/dimensions.js";

export interface ResolvedModel {
  model: EvaluableModel;
  /** Where the model came from (for output metadata / debugging). */
  source: "xlsx_cell_graph" | "formula_dag" | "external_model";
  documentId?: string;
  modelSchema?: XlsxModelSchemaLike;
  snapshotId?: string;
  dimensionalDef?: DimensionalModelDefinition;
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
  workbook_snapshot: import("./ingestionArtifacts.js").SparseWorkbookSnapshot | null;
  validation_status: string | null;
}

interface ActiveUserModelRow {
  model_id: string;
  source_kind: string;
  snapshot_id: string | null;
  model_definition: unknown;
}

async function findSpreadsheetModelDoc(workspaceId: string): Promise<SpreadsheetDocRow | null> {
  const r = await pool.query(
    `SELECT document_id, updated_at, model_schema, workbook_graph, workbook_snapshot, validation_status
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

async function findActiveUserModel(workspaceId: string): Promise<ActiveUserModelRow | null> {
  const r = await pool.query(
    `SELECT model_id, COALESCE(source_kind, 'documents') AS source_kind, snapshot_id, model_definition
     FROM user_models
     WHERE workspace_id = $1 AND is_active = true
     ORDER BY created_at DESC
     LIMIT 1`,
    [workspaceId],
  );
  return (r.rows[0] as ActiveUserModelRow | undefined) ?? null;
}

async function findPinnedUserModel(
  workspaceId: string,
  modelId: string | null,
): Promise<ActiveUserModelRow | null> {
  if (!modelId) return null;
  const r = await pool.query(
    `SELECT model_id, COALESCE(source_kind, 'documents') AS source_kind, snapshot_id, model_definition
     FROM user_models
     WHERE workspace_id = $1 AND model_id::text = $2
     LIMIT 1`,
    [workspaceId, modelId],
  );
  return (r.rows[0] as ActiveUserModelRow | undefined) ?? null;
}

async function resolveExternalModel(row: ActiveUserModelRow): Promise<ResolvedModel> {
  if (!row.snapshot_id || row.source_kind !== "external_model") {
    throw new ModelResolutionError("External model snapshot is missing");
  }
  const def = row.model_definition;
  if (!isDimensionalModelDefinition(def)) {
    throw new ModelResolutionError(
      "External model has an invalid dimensional definition. Re-import the planning model.",
    );
  }
  const model = await getDimensionalRuntime(row.snapshot_id, def);
  return {
    model,
    source: "external_model",
    snapshotId: row.snapshot_id,
    dimensionalDef: def,
  };
}

// Each entry holds a fully materialized dimensional model (all leaf facts
// resolved into memory), so keep the ceiling modest — this is a small number
// of distinct external-model snapshots actively in use, not a per-request
// cache. Explicit invalidation (clearDimensionalRuntimeCache) still applies
// after a snapshot refresh; the cap only guards against unbounded growth
// from long-tail/abandoned snapshots.
const dimensionalCache = new LruCache<string, DimensionalModel>({ maxEntries: 200 });

async function getDimensionalRuntime(
  snapshotId: string,
  def: DimensionalModelDefinition,
): Promise<DimensionalModel> {
  const cached = dimensionalCache.get(snapshotId);
  if (cached) return cached;

  const factsRes = await pool.query(
    `SELECT measure_id, member_key, value::float AS value
     FROM external_model_facts WHERE snapshot_id = $1`,
    [snapshotId],
  );
  const leafFacts = factsToLeafMap(factsRes.rows);
  const model = new DimensionalModel(def, leafFacts);
  dimensionalCache.set(snapshotId, model);
  return model;
}

/** Clear dimensional runtime cache (tests / after refresh). */
export function clearDimensionalRuntimeCache(snapshotId?: string): void {
  if (snapshotId) dimensionalCache.delete(snapshotId);
  else dimensionalCache.clear();
}

export async function getEvaluableModelForScenario(scenarioId: string): Promise<ResolvedModel> {
  const scenarioRes = await pool.query(
    "SELECT creator_id, workspace_id, model_version_hash FROM scenarios WHERE scenario_id = $1",
    [scenarioId],
  );
  if (scenarioRes.rows.length === 0) throw new ModelResolutionError("Scenario not found", 404);
  const { creator_id: creatorId, workspace_id: workspaceIdRaw, model_version_hash: modelVersion } =
    scenarioRes.rows[0];

  let workspaceId: string | null = workspaceIdRaw;
  if (!workspaceId) {
    const { ensureDefaultWorkspace } = await import("./workspaceService.js");
    workspaceId = await ensureDefaultWorkspace(creatorId);
  }

  // 1. Preserve the external snapshot that the scenario was created against.
  const pinned = await findPinnedUserModel(workspaceId, modelVersion);
  if (pinned?.source_kind === "external_model" && pinned.snapshot_id) {
    return resolveExternalModel(pinned);
  }

  // 2. Active external planning model wins over spreadsheet / formula DAG.
  const active = await findActiveUserModel(workspaceId);
  if (active?.source_kind === "external_model" && active.snapshot_id) {
    return resolveExternalModel(active);
  }

  // 3. Validated spreadsheet model document (HyperFormula — never use xlsx_catalog DAG)
  const doc = await findSpreadsheetModelDoc(workspaceId);
  if (doc) {
    // Name the actual reason. "Not validated yet" is true but useless when what
    // is really blocking is a specific value in the user's own upload.
    const { listBlockingFindings } = await import("./dataQuality.js");
    const blocking = await listBlockingFindings(doc.document_id);
    if (blocking.length > 0) {
      throw new ModelResolutionError(
        `This model has ${blocking.length} unreviewed data issue(s) in the uploaded workbook: ` +
          `${blocking
            .map((f) => `${f.sheet}${f.cells.length ? `!${f.cells.join("/")}` : ""} — ${f.title}`)
            .join("; ")}. ` +
          `Open Data Quality, decide on each one, then run again.`,
      );
    }

    if (doc.validation_status !== "ready") {
      throw new ModelResolutionError(
        "Spreadsheet model is not validated yet. Please complete analyst validation before simulation.",
      );
    }
    // Reviewed bindings win over the raw model_schema: they carry the unique
    // block-qualified ids, the Active-column write targets, and the period-total
    // cells, and they exclude anything a reviewer rejected. Fall back to
    // model_schema for documents ingested before the binding layer existed.
    const bindingSchema = await loadBindingSchema(doc.document_id);
    const effectiveSchema = bindingSchema ?? doc.model_schema;
    const runtime = doc.workbook_graph
      ? getXlsxRuntime(
          `${doc.document_id}:${sha256(
            stableStringify({
              snapshot: doc.workbook_snapshot ?? doc.workbook_graph,
              schema: effectiveSchema,
            }),
          )}`,
          doc.workbook_graph,
          effectiveSchema,
          doc.workbook_snapshot,
        )
      : null;
    if (!runtime) {
      throw new ModelResolutionError(
        "Spreadsheet runtime could not be built from the stored formula snapshot. " +
          "Please re-upload the XLSX file (or run reprocess-workbooks.ts) and rebuild the model context.",
      );
    }
    return {
      model: runtime,
      source: "xlsx_cell_graph",
      documentId: doc.document_id,
      modelSchema: effectiveSchema,
    };
  }

  // 4. Formula DAG from user_models / registry (skip non-executable XLSX catalogs)
  const activeCatalog = await findActiveUserModel(workspaceId);
  if (activeCatalog?.source_kind === "xlsx_catalog") {
    throw new ModelResolutionError(
      "Active XLSX model catalog is not executable without a validated spreadsheet snapshot. " +
        "Re-upload the workbook and complete model validation.",
    );
  }

  // Text/PDF-derived models with unresolved tie-out variances are not executable.
  try {
    const ctxRes = await pool.query(
      `SELECT context_data FROM company_context
       WHERE workspace_id = $1 AND status = 'active'
       ORDER BY created_at DESC LIMIT 1`,
      [workspaceId],
    );
    const usability = (ctxRes.rows[0]?.context_data as { usability?: string } | undefined)?.usability;
    if (usability === "needs_review") {
      throw new ModelResolutionError(
        "Text-derived model has unresolved tie-out variances (needs_review). " +
          "Review cross-foot discrepancies or rebuild context before simulation.",
      );
    }
  } catch (e) {
    if (e instanceof ModelResolutionError) throw e;
  }

  const modelDef = await getModelDefinition(modelVersion);
  if (!modelDef) {
    throw new ModelResolutionError("No model found. Please build a model from your documents first.");
  }
  return { model: new CompiledModel(modelDef), source: "formula_dag" };
}

// ── Scenario overrides (typed deltas + optional member_scope) ──

export interface ScenarioOverride extends TypedOverride {
  variableId: string;
  memberScope?: Record<string, string> | null;
}

export async function loadScenarioOverrides(scenarioId: string): Promise<ScenarioOverride[]> {
  const r = await pool.query(
    `SELECT mapped_variable_id, scenario_value, delta_type, member_scope
     FROM scenario_parameters
     WHERE scenario_id = $1 AND status IN ('pending', 'accepted', 'modified')`,
    [scenarioId],
  );
  return r.rows.map(
    (row: {
      mapped_variable_id: string;
      scenario_value: string;
      delta_type: string;
      member_scope: Record<string, string> | null;
    }) => ({
      variableId: row.mapped_variable_id,
      value: Number(row.scenario_value),
      delta_type: (row.delta_type === "percent"
        ? "percent"
        : row.delta_type === "additive"
          ? "additive"
          : "absolute") as DeltaType,
      memberScope: row.member_scope ?? undefined,
    }),
  );
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
  // An engine may answer to pre-qualification ids as well as its current ones.
  // Resolving through it keeps the base we read and the cell we write on the
  // same lever — the divergence that turned "+7.5%" into an arbitrary multiple.
  const resolveId = (id: string): string => {
    if (baseById.has(id)) return id;
    const resolver = (model as { resolveInputId?: (i: string) => string | undefined })
      .resolveInputId;
    return (typeof resolver === "function" ? resolver.call(model, id) : undefined) ?? id;
  };
  const absolute: Record<string, number> = {};
  const unresolved: string[] = [];

  for (const raw of overrides) {
    if (!Number.isFinite(raw.value)) continue;
    const o = { ...raw, variableId: resolveId(raw.variableId) };
    const base = baseById.get(o.variableId);
    if (o.delta_type === "percent") {
      if (base == null || base === 0) {
        unresolved.push(o.variableId);
        continue;
      }
      absolute[o.variableId] = base * (1 + o.value / 100);
    } else if (o.delta_type === "additive") {
      if (base == null) {
        unresolved.push(o.variableId);
        continue;
      }
      absolute[o.variableId] = base + o.value;
    } else {
      absolute[o.variableId] = o.value;
    }
  }
  return { absolute, unresolved };
}

export function toDimensionalOverrides(overrides: ScenarioOverride[]): DimensionalOverride[] {
  return overrides.map((o) => ({
    variableId: o.variableId,
    memberScope: o.memberScope ?? undefined,
    value: o.value,
    delta_type: o.delta_type,
  }));
}
