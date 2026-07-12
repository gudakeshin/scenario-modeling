/**
 * Map planning-system metadata + facts → DimensionalModelDefinition and activate
 * as the workspace's active user_models row (source_kind=external_model).
 *
 * LLM is only used for calculated measures with no exposed formula (opt-in).
 * Dimension/member/hierarchy/signage/facts are never LLM-touched.
 */

import { z } from "zod";
import { pool } from "../db/index.js";
import type { Scope } from "../middleware/workspace.js";
import type { PlanningModelMetadata, PlanningMeasure } from "../connectors/types.js";
import type {
  DimensionalModelDefinition,
  DimensionalVariable,
  Dimension,
  Member,
  AggregationKind,
} from "../models/dimensions.js";
import type { TimeHorizon } from "../models/registry.js";
import { DimensionalModel, factsToLeafMap } from "./dimensionalModel.js";
import { callClaudeStructured, getApiKey } from "./llmClient.js";
import { logger } from "../logger.js";
import { clearDimensionalRuntimeCache } from "./modelResolver.js";
import { writeIntegrationEvent } from "./connectionService.js";

export interface CrossFootWarning {
  measure_id: string;
  member_key: string;
  source: number;
  computed: number;
  variance_pct: number;
  message: string;
}

function mapAggregation(m: PlanningMeasure): AggregationKind {
  if (m.aggregation === "avg") return "avg";
  if (m.aggregation === "last") return "last";
  return "sum";
}

function inferTimeHorizon(meta: PlanningModelMetadata): {
  time_dimension_id?: string;
  time_horizon: TimeHorizon;
} {
  const timeDim = meta.dimensions.find((d) => d.type === "time");
  if (!timeDim) {
    return {
      time_horizon: { start: "2024-01", end: "2024-12", granularity: "monthly" },
    };
  }
  const leaves = timeDim.members
    .filter((m) => m.isLeaf)
    .sort((a, b) => a.ordinal - b.ordinal);
  const names = leaves.map((m) => m.name);
  const start = names[0] ?? "2024-01";
  const end = names[names.length - 1] ?? start;
  const granularity: "monthly" | "quarterly" = /Q[1-4]/i.test(start) ? "quarterly" : "monthly";
  // Normalize names like 2024.01 → 2024-01
  const norm = (s: string) => s.replace(/\./g, "-").replace(/\s+/g, "");
  return {
    time_dimension_id: timeDim.id,
    time_horizon: { start: norm(start), end: norm(end), granularity },
  };
}

export interface MappingPreviewMeasure {
  id: string;
  name: string;
  role: "input" | "formula_exposed" | "formula_derived_on_import";
  signage_note?: string;
}

export interface MappingPreview {
  model_id: string;
  model_name: string;
  measures: MappingPreviewMeasure[];
  account_signage: boolean;
  notes: string[];
}

/**
 * Heuristic-only mapping preview (no LLM). Classifies measures the same way
 * activateExternalModel decides which need formula derivation.
 */
export function buildMappingPreview(meta: PlanningModelMetadata): MappingPreview {
  const accountDim = meta.dimensions.find((d) => d.type === "account");
  const notes: string[] = [];
  if (accountDim) {
    notes.push("Account rollups use source signage (signed_sum) on import.");
  }

  const measures: MappingPreviewMeasure[] = meta.measures.map((measure) => {
    if (measure.formula) {
      return {
        id: measure.id,
        name: measure.name,
        role: "formula_exposed",
        signage_note: accountDim ? "Uses account signage when activated" : undefined,
      };
    }
    const looksDerived =
      /calc|derived|margin|ratio/i.test(measure.name) || !!measure.attributes?.calculated;
    if (looksDerived) {
      return {
        id: measure.id,
        name: measure.name,
        role: "formula_derived_on_import",
        signage_note: "Formula derived on import (LLM assist when available)",
      };
    }
    return {
      id: measure.id,
      name: measure.name,
      role: "input",
      signage_note: accountDim ? "Direct input; account signage applied on rollup" : "Direct input from facts",
    };
  });

  return {
    model_id: meta.modelId,
    model_name: meta.modelName,
    measures,
    account_signage: !!accountDim,
    notes,
  };
}

export function mapMetadataToDefinition(
  meta: PlanningModelMetadata,
  opts?: { llmFormulas?: Map<string, { formula: string; dependencies: string[]; confidence: number }> },
): DimensionalModelDefinition {
  const warnings: string[] = [];
  const dimensions: Dimension[] = meta.dimensions.map((d) => ({
    id: d.id,
    name: d.name,
    type: d.type,
    defaultHierarchyId: d.defaultHierarchyId,
    members: d.members.map(
      (m): Member => ({
        id: m.id,
        name: m.name,
        parentId: m.parentId,
        isLeaf: m.isLeaf,
        sign: m.sign,
        attributes: m.attributes,
        ordinal: m.ordinal,
      }),
    ),
  }));

  const accountDim = dimensions.find((d) => d.type === "account");
  // Preserve source dimension order for member_key alignment (including version).
  const measureDims = dimensions.map((d) => d.id);

  const variables: DimensionalVariable[] = [];

  for (const measure of meta.measures) {
    const llm = opts?.llmFormulas?.get(measure.id);
    if (measure.formula) {
      // Source-exposed formula
      const deps = [...measure.formula.matchAll(/\b([a-z][a-z0-9_]*)\b/gi)]
        .map((m) => m[1])
        .filter((id) => id !== measure.id && meta.measures.some((x) => x.id === id));
      variables.push({
        id: measure.id,
        name: measure.name,
        dims: measureDims,
        formula: measure.formula,
        dependencies: deps,
        aggregation: accountDim ? "signed_sum" : mapAggregation(measure),
        tags: ["pl_metric", "percent_delta"],
        metric_type: measure.unit?.toLowerCase().includes("unit") ? "volume" : "currency",
        provenance: "extracted",
      });
    } else if (llm) {
      variables.push({
        id: measure.id,
        name: measure.name,
        dims: measureDims,
        formula: llm.formula,
        dependencies: llm.dependencies,
        aggregation: accountDim ? "signed_sum" : mapAggregation(measure),
        tags: ["pl_metric", "percent_delta"],
        metric_type: "currency",
        provenance: "derived",
      });
      warnings.push(
        `Measure '${measure.id}' formula derived by LLM (confidence ${llm.confidence}) — review before relying on it.`,
      );
    } else {
      // Input measure from facts
      variables.push({
        id: measure.id,
        name: measure.name,
        dims: measureDims,
        formula: "0",
        dependencies: [],
        aggregation: accountDim ? "signed_sum" : mapAggregation(measure),
        tags: ["pl_metric", "percent_delta"],
        metric_type: measure.unit?.toLowerCase().includes("unit") ? "volume" : "currency",
        provenance: "extracted",
      });
    }
  }

  // Account hierarchy structural rollups are expressed via signed_sum aggregation
  // on the amount measure — parentage/signage come only from source master data.
  if (accountDim) {
    warnings.push(
      "Account rollups use source signage (signed_sum); hierarchy parentage is source-derived.",
    );
  }

  const { time_dimension_id, time_horizon } = inferTimeHorizon(meta);

  return {
    model_kind: "dimensional",
    model_version: `external:${meta.modelId}`,
    dimensions,
    variables,
    time_dimension_id,
    time_horizon,
    build_warnings: warnings,
  };
}

export function crossFootDimensional(
  def: DimensionalModelDefinition,
  leafFacts: Map<string, Map<string, number>>,
  sourceAggregates: Array<{ measure_id: string; member_key: string; value: number }> | undefined,
  tolerancePct = 1,
): CrossFootWarning[] {
  if (!sourceAggregates?.length) return [];
  const model = new DimensionalModel(def, leafFacts);
  const warnings: CrossFootWarning[] = [];

  for (const agg of sourceAggregates) {
    const parts = agg.member_key.split("|");
    const v = def.variables.find((x) => x.id === agg.measure_id);
    if (!v) continue;
    const pov: Record<string, string> = {};
    // Map member key parts to dims by position
    for (let i = 0; i < Math.min(parts.length, v.dims.length); i++) {
      pov[v.dims[i]] = parts[i];
    }
    const result = model.evaluateDimensional([]);
    const computed = result.valueAt(agg.measure_id, pov);
    if (computed === undefined || !Number.isFinite(agg.value) || agg.value === 0) continue;
    const variance_pct = (Math.abs(computed - agg.value) / Math.abs(agg.value)) * 100;
    if (variance_pct > tolerancePct) {
      warnings.push({
        measure_id: agg.measure_id,
        member_key: agg.member_key,
        source: agg.value,
        computed,
        variance_pct,
        message: `Cross-foot ${agg.measure_id}@${agg.member_key}: source=${agg.value}, computed=${computed} (${variance_pct.toFixed(1)}%)`,
      });
    }
  }
  return warnings;
}

const llmFormulaSchema = z.object({
  formula: z.string(),
  dependencies: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1).default(0.5),
});

async function maybeDeriveFormula(
  measure: PlanningMeasure,
  allMeasures: PlanningMeasure[],
): Promise<{ formula: string; dependencies: string[]; confidence: number } | null> {
  if (measure.formula) return null;
  if (!getApiKey()) return null;
  try {
    return await callClaudeStructured({
      system:
        "You derive a simple arithmetic formula for a calculated planning measure from sibling measure ids. " +
        "Only use known measure ids as dependencies. Return JSON.",
      userMessage: `Measure: ${measure.id} (${measure.name})\nAvailable measures: ${allMeasures.map((m) => m.id).join(", ")}\nPropose formula.`,
      schema: llmFormulaSchema,
      purpose: "connector_map",
      toolName: "submit_measure_formula",
      toolDescription: "Submit derived formula for a calculated measure",
    });
  } catch (e) {
    logger.warn({ err: e, measure: measure.id }, "LLM formula derivation failed");
    return null;
  }
}

/**
 * Activate a ready snapshot as the workspace's active external model.
 */
export async function activateExternalModel(
  scope: Scope,
  snapshotId: string,
  stats?: Record<string, unknown>,
): Promise<void> {
  const snap = await pool.query(
    `SELECT snapshot_id, workspace_id, connection_id, external_model_id,
            status, metadata, external_model_name
     FROM external_model_snapshots
     WHERE snapshot_id = $1 AND workspace_id = $2`,
    [snapshotId, scope.workspaceId],
  );
  if (snap.rows.length === 0) {
    throw new Error("Snapshot not found");
  }
  const row = snap.rows[0];
  if (row.status !== "importing" && row.status !== "ready") {
    throw new Error(`Snapshot status is '${row.status}', expected 'importing' or 'ready'`);
  }

  const meta = row.metadata as PlanningModelMetadata;
  const llmFormulas = new Map<string, { formula: string; dependencies: string[]; confidence: number }>();

  for (const measure of meta.measures ?? []) {
    if (measure.formula) continue;
    // Only attempt LLM for measures that look calculated (name hints) and have no facts? Skip by default for v1
    // Plan says optional LLM assist for calculated measures with no exposed formula.
    if (/calc|derived|margin|ratio/i.test(measure.name) || measure.attributes?.calculated) {
      const derived = await maybeDeriveFormula(measure, meta.measures);
      if (derived) llmFormulas.set(measure.id, derived);
    }
  }

  const def = mapMetadataToDefinition(meta, { llmFormulas });

  const factsRes = await pool.query(
    `SELECT measure_id, member_key, value::float AS value
     FROM external_model_facts WHERE snapshot_id = $1`,
    [snapshotId],
  );
  const leafFacts = factsToLeafMap(factsRes.rows);
  const cf = crossFootDimensional(def, leafFacts, meta.source_aggregates);
  for (const w of cf) {
    def.build_warnings = def.build_warnings ?? [];
    def.build_warnings.push(w.message);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE user_models SET is_active = false WHERE workspace_id = $1 AND is_active`,
      [scope.workspaceId],
    );
    await client.query(
      `INSERT INTO user_models
         (created_by, workspace_id, name, model_definition, source_kind, snapshot_id, is_active)
       VALUES ($1, $2, $3, $4, 'external_model', $5, true)`,
      [
        scope.userId,
        scope.workspaceId,
        row.external_model_name || meta.modelName || "External Model",
        JSON.stringify(def),
        snapshotId,
      ],
    );
    await client.query(
      `UPDATE external_model_snapshots
       SET status = 'superseded', updated_at = NOW()
       WHERE connection_id = $1
         AND external_model_id = $2
         AND snapshot_id <> $3
         AND status = 'ready'`,
      [row.connection_id, row.external_model_id, snapshotId],
    );
    await client.query(
      `UPDATE external_model_snapshots
       SET status = 'ready',
           stats = COALESCE($1::jsonb, stats),
           error = NULL,
           updated_at = NOW()
       WHERE snapshot_id = $2`,
      [stats ? JSON.stringify(stats) : null, snapshotId],
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }

  await writeIntegrationEvent({
    workspaceId: scope.workspaceId,
    userId: scope.userId,
    eventType: "model.activated",
    details: {
      snapshot_id: snapshotId,
      warnings: def.build_warnings?.length ?? 0,
      cross_foot: cf.length,
    },
  });

  clearDimensionalRuntimeCache(snapshotId);
  logger.info({ snapshotId, workspaceId: scope.workspaceId }, "External model activated");
}
