/**
 * Semantic binding layer over the XLSX cell snapshot.
 *
 * The workbook stays the source of truth and HyperFormula stays the evaluator —
 * this module only decides *which cell means what*, which is where the previous
 * pipeline went wrong. Identity came from `toId(rowLabel)`, so a workbook that
 * repeats a label across sections ("Bullet" under both VOLUME GROWTH and PRICE
 * CHANGE) produced one id for two cells; the runtime bound the last one while
 * reporting the first one's base, turning a +7.5% instruction into an arbitrary
 * multiple. Bindings are therefore persisted with a unique, block-qualified
 * slug, the structural facts the runtime needs, and the evidence a reviewer
 * needs to confirm or reject them.
 */

import type { PoolClient } from "pg";
import { pool } from "../db/index.js";
import { canonicalMetricId } from "./metricTypes.js";
import type { WorkbookGraph } from "./excelExtractor.js";
import type { LeverBindingEvidence, RuntimeBuildResult, XlsxModelSchemaLike } from "./xlsxRuntime.js";

export type BindingKind = "lever" | "output";
export type BindingRole = "constant_input" | "derived" | "reference";
export type BindingStatus = "proposed" | "confirmed" | "rejected";

export interface ModelBinding {
  bindingKind: BindingKind;
  bindingSlug: string;
  aliases: string[];
  label: string;
  blockLabel?: string;
  sheet: string;
  cell?: string;
  activeCell?: string;
  toggleCell?: string;
  aggregateCell?: string;
  unit?: string;
  role: BindingRole;
  canonicalMetric?: string;
  baseValue?: number;
  probeEvidence?: LeverBindingEvidence;
  movesOutputs?: boolean;
  status: BindingStatus;
}

export interface BindingHealth {
  ok: boolean;
  totalLevers: number;
  inertLevers: string[];
  duplicateSlugs: string[];
  formulaLevers: string[];
  issues: string[];
}

/** Share of levers allowed to move nothing before the model is untrustworthy. */
const MAX_INERT_LEVER_RATIO = 0.3;

/**
 * Build binding records from the extracted graph, the resolved schema, and the
 * runtime's directional probe.
 */
export function deriveBindings(
  graph: WorkbookGraph,
  schema: XlsxModelSchemaLike,
  build: RuntimeBuildResult,
): ModelBinding[] {
  const bindings: ModelBinding[] = [];
  const evidence = build.bindingEvidence ?? {};
  const inputById = new Map((graph.inputCandidates || []).map((c) => [c.id, c]));
  const outputById = new Map((graph.outputCandidates || []).map((c) => [c.id, c]));
  const toggleCell = graph.scenarioToggle?.cell;

  for (const lever of schema.scenarioLevers || []) {
    const candidate = inputById.get(lever.id);
    const ev = evidence[lever.id];
    const aliases = new Set<string>();
    if (candidate?.aliasId) aliases.add(candidate.aliasId);
    if (lever.id !== lever.label) aliases.add(lever.id);

    bindings.push({
      bindingKind: "lever",
      bindingSlug: lever.id,
      aliases: [...aliases].filter((a) => a && a !== lever.id),
      label: lever.label || lever.id,
      blockLabel: candidate?.blockLabel,
      sheet: lever.sheet || candidate?.sheet || "",
      cell: lever.cell || candidate?.cell,
      activeCell: lever.activeCell || candidate?.activeCell,
      // A toggle only matters to a lever that has an Active twin to resolve.
      toggleCell: lever.activeCell || candidate?.activeCell ? toggleCell : undefined,
      unit: candidate?.isFormula ? undefined : "value",
      role: candidate?.isFormula ? "derived" : "constant_input",
      canonicalMetric: canonicalMetricId(lever.id),
      baseValue: lever.scenarios?.base ?? candidate?.value,
      probeEvidence: ev,
      movesOutputs: ev ? ev.affectedOutputs.length > 0 : undefined,
      status: "proposed",
    });
  }

  for (const metric of schema.outputMetrics || []) {
    const candidate = outputById.get(metric.id);
    bindings.push({
      bindingKind: "output",
      bindingSlug: metric.id,
      aliases: candidate?.aliasId && candidate.aliasId !== metric.id ? [candidate.aliasId] : [],
      label: metric.label || metric.id,
      blockLabel: candidate?.blockLabel,
      sheet: metric.sheet || candidate?.sheet || "",
      cell: metric.cell || candidate?.cell,
      aggregateCell: metric.aggregateCell || candidate?.aggregateCell,
      role: "derived",
      canonicalMetric: canonicalMetricId(metric.id),
      baseValue: candidate?.value,
      status: "proposed",
    });
  }

  return bindings;
}

/**
 * Judge whether a set of bindings is trustworthy enough to simulate against.
 *
 * The signals are the ones that previously produced confident-looking nonsense:
 * levers that move nothing, ids claimed by more than one cell, and formula
 * cells offered as inputs.
 */
export function assessBindingHealth(bindings: ModelBinding[]): BindingHealth {
  const levers = bindings.filter((b) => b.bindingKind === "lever");
  const inertLevers = levers
    .filter((b) => b.movesOutputs === false)
    .map((b) => `${b.bindingSlug} (${b.sheet}!${b.cell ?? "?"})`);
  const formulaLevers = levers
    .filter((b) => b.role === "derived")
    .map((b) => `${b.bindingSlug} (${b.sheet}!${b.cell ?? "?"})`);

  const seen = new Map<string, number>();
  for (const b of bindings) {
    const key = `${b.bindingKind}:${b.bindingSlug}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const duplicateSlugs = [...seen.entries()]
    .filter(([, count]) => count > 1)
    .map(([key]) => key);

  const issues: string[] = [];
  if (duplicateSlugs.length > 0) {
    issues.push(
      `${duplicateSlugs.length} binding id(s) are claimed by more than one cell: ` +
        `${duplicateSlugs.join(", ")}. Overrides on these would write an unpredictable cell.`,
    );
  }
  if (formulaLevers.length > 0) {
    issues.push(
      `${formulaLevers.length} lever(s) point at computed cells: ${formulaLevers.join(", ")}. ` +
        `Overriding a formula cell replaces the model's own arithmetic.`,
    );
  }
  const inertRatio = levers.length > 0 ? inertLevers.length / levers.length : 0;
  if (inertRatio > MAX_INERT_LEVER_RATIO) {
    issues.push(
      `${inertLevers.length} of ${levers.length} levers move no output ` +
        `(${Math.round(inertRatio * 100)}%). Scenarios built on them would report success ` +
        `while changing nothing. Review or reject: ${inertLevers.slice(0, 10).join(", ")}` +
        `${inertLevers.length > 10 ? ", …" : ""}`,
    );
  }

  return {
    ok: issues.length === 0,
    totalLevers: levers.length,
    inertLevers,
    duplicateSlugs,
    formulaLevers,
    issues,
  };
}

/** Replace the stored bindings for a document. */
export async function persistBindings(
  documentId: string,
  workspaceId: string | null,
  artifactVersion: string | null,
  bindings: ModelBinding[],
  client?: PoolClient,
): Promise<number> {
  const db = client ?? pool;
  await db.query("DELETE FROM model_bindings WHERE document_id = $1", [documentId]);
  if (bindings.length === 0) return 0;

  let written = 0;
  for (const b of bindings) {
    // ON CONFLICT keeps ingestion resilient to a workbook that still yields a
    // duplicate slug; assessBindingHealth reports it rather than the insert
    // failing the whole upload.
    const res = await db.query(
      `INSERT INTO model_bindings (
         document_id, workspace_id, artifact_version, binding_kind, binding_slug, aliases,
         label, block_label, sheet, cell, active_cell, toggle_cell, aggregate_cell,
         unit, role, canonical_metric, base_value, probe_evidence, moves_outputs, status
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       ON CONFLICT (document_id, binding_kind, binding_slug) DO NOTHING
       RETURNING binding_id`,
      [
        documentId,
        workspaceId,
        artifactVersion,
        b.bindingKind,
        b.bindingSlug,
        b.aliases,
        b.label,
        b.blockLabel ?? null,
        b.sheet,
        b.cell ?? null,
        b.activeCell ?? null,
        b.toggleCell ?? null,
        b.aggregateCell ?? null,
        b.unit ?? null,
        b.role,
        b.canonicalMetric ?? null,
        Number.isFinite(b.baseValue) ? b.baseValue : null,
        b.probeEvidence ? JSON.stringify(b.probeEvidence) : null,
        b.movesOutputs ?? null,
        b.status,
      ],
    );
    written += res.rowCount ?? 0;
  }
  return written;
}

interface BindingRow {
  binding_kind: BindingKind;
  binding_slug: string;
  aliases: string[] | null;
  label: string;
  block_label: string | null;
  sheet: string;
  cell: string | null;
  active_cell: string | null;
  aggregate_cell: string | null;
  role: BindingRole;
  canonical_metric: string | null;
  base_value: string | null;
  status: BindingStatus;
  moves_outputs: boolean | null;
}

/**
 * Load confirmed/proposed bindings for a document as a runtime schema.
 * Rejected bindings are dropped — that is how a reviewer removes a bad lever.
 */
export async function loadBindingSchema(
  documentId: string,
): Promise<XlsxModelSchemaLike | null> {
  const res = await pool.query<BindingRow>(
    `SELECT binding_kind, binding_slug, aliases, label, block_label, sheet, cell,
            active_cell, aggregate_cell, role, canonical_metric, base_value, status, moves_outputs
     FROM model_bindings
     WHERE document_id = $1 AND status <> 'rejected'
     ORDER BY binding_kind, binding_slug`,
    [documentId],
  );
  if (res.rows.length === 0) return null;

  const scenarioLevers: NonNullable<XlsxModelSchemaLike["scenarioLevers"]> = [];
  const outputMetrics: NonNullable<XlsxModelSchemaLike["outputMetrics"]> = [];
  const baseValues: Record<string, number> = {};

  for (const row of res.rows) {
    const base = row.base_value == null ? undefined : Number(row.base_value);
    if (base != null && Number.isFinite(base)) baseValues[row.binding_slug] = base;

    if (row.binding_kind === "lever") {
      // A derived binding is a computed cell — reportable, never writable.
      if (row.role === "derived") continue;
      scenarioLevers.push({
        id: row.binding_slug,
        label: row.label,
        sheet: row.sheet,
        ...(row.cell ? { cell: row.cell } : {}),
        ...(row.active_cell ? { activeCell: row.active_cell } : {}),
        ...(base != null && Number.isFinite(base) ? { scenarios: { base } } : {}),
      });
    } else {
      outputMetrics.push({
        id: row.binding_slug,
        label: row.label,
        sheet: row.sheet,
        ...(row.cell ? { cell: row.cell } : {}),
        ...(row.aggregate_cell ? { aggregateCell: row.aggregate_cell } : {}),
      });
    }
  }

  if (scenarioLevers.length === 0 && outputMetrics.length === 0) return null;
  return { scenarioLevers, outputMetrics, baseValues };
}

/** Bindings a reviewer still needs to look at. */
export async function listBindingsForReview(documentId: string): Promise<BindingRow[]> {
  const res = await pool.query<BindingRow>(
    `SELECT binding_kind, binding_slug, aliases, label, block_label, sheet, cell,
            active_cell, aggregate_cell, role, canonical_metric, base_value, status, moves_outputs
     FROM model_bindings
     WHERE document_id = $1 AND status = 'proposed' AND moves_outputs = false
     ORDER BY binding_slug`,
    [documentId],
  );
  return res.rows;
}

/** Record a reviewer's decision on one binding. */
export async function reviewBinding(
  documentId: string,
  bindingKind: BindingKind,
  bindingSlug: string,
  status: Exclude<BindingStatus, "proposed">,
  userId: string,
): Promise<boolean> {
  const res = await pool.query(
    `UPDATE model_bindings
     SET status = $4, reviewed_by = $5, reviewed_at = NOW(), updated_at = NOW()
     WHERE document_id = $1 AND binding_kind = $2 AND binding_slug = $3
     RETURNING binding_id`,
    [documentId, bindingKind, bindingSlug, status, userId],
  );
  return (res.rowCount ?? 0) > 0;
}
