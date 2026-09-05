import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import type { PoolClient } from "pg";
import { pool } from "../db/index.js";
import { computeChainHash, sha256, stableStringify } from "../utils/hashChain.js";

const require = createRequire(import.meta.url);
const hyperFormulaVersion = (() => {
  try {
    const entry = require.resolve("hyperformula");
    return (JSON.parse(
      readFileSync(join(dirname(entry), "..", "package.json"), "utf8"),
    ) as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
})();

export interface RunManifestRow {
  manifest_id: string;
  run_id: string;
  scenario_id: string;
  scenario_version_id: string;
  workspace_id: string | null;
  model_document_id: string | null;
  model_hash: string;
  engine: Record<string, unknown>;
  levers: unknown[];
  denomination: Record<string, unknown>;
  mc: Record<string, unknown> | null;
  created_by: string;
  created_at: string;
  prev_hash: string;
  row_hash: string;
}

export interface ManifestChainVerifyResult {
  valid: boolean;
  checked: number;
  firstBadId?: string;
  reason?: string;
}

function canonicalManifestPayload(row: Omit<RunManifestRow, "prev_hash" | "row_hash">): string {
  return stableStringify({
    created_at: row.created_at,
    created_by: row.created_by,
    denomination: row.denomination,
    engine: row.engine,
    levers: row.levers,
    manifest_id: row.manifest_id,
    mc: row.mc,
    model_document_id: row.model_document_id,
    model_hash: row.model_hash,
    run_id: row.run_id,
    scenario_id: row.scenario_id,
    scenario_version_id: row.scenario_version_id,
    workspace_id: row.workspace_id,
  });
}

/**
 * Append one immutable manifest. The caller must pass the same transaction
 * that inserted the scenario output and scenario version.
 */
export async function createRunManifest(
  input: {
    runId: string;
    scenarioId: string;
    scenarioVersionId: string;
    workspaceId: string | null;
    createdBy: string;
    resolvedVariables: Record<string, number>;
    mc?: Record<string, unknown> | null;
  },
  client: PoolClient,
): Promise<RunManifestRow> {
  const scenario = await client.query<{
    model_version_hash: string;
  }>(
    `SELECT model_version_hash FROM scenarios WHERE scenario_id = $1`,
    [input.scenarioId],
  );
  if (scenario.rows.length === 0) throw new Error("Scenario not found for run manifest");

  const params = await client.query<{
    parameter_id: string;
    extracted_name: string;
    mapped_variable_id: string;
    base_value: string | number | null;
    scenario_value: string | number;
    delta_type: string | null;
    status: string;
    binding_evidence: Record<string, unknown> | null;
    owner_user_id?: string | null;
    source_citation?: string | null;
    rationale?: string | null;
    effective_from?: string | null;
    review_status?: string | null;
  }>(
    `SELECT parameter_id, extracted_name, mapped_variable_id, base_value,
            scenario_value, delta_type, status, binding_evidence,
            owner_user_id, source_citation, rationale, effective_from, review_status
     FROM scenario_parameters
     WHERE scenario_id = $1 AND status <> 'rejected'
     ORDER BY created_at, parameter_id`,
    [input.scenarioId],
  );

  const document = input.workspaceId
    ? await client.query<{
        document_id: string;
        workbook_graph: unknown;
        workbook_snapshot: unknown;
        model_schema: unknown;
        artifact_version: number | null;
      }>(
        `SELECT document_id, workbook_graph, workbook_snapshot, model_schema, artifact_version
         FROM documents
         WHERE workspace_id = $1 AND model_schema IS NOT NULL
         ORDER BY CASE WHEN validation_status = 'ready' THEN 0 ELSE 1 END, updated_at DESC
         LIMIT 1`,
        [input.workspaceId],
      )
    : { rows: [] };
  const doc = document.rows[0];
  const modelHash = doc
    ? sha256(stableStringify({
        artifact_version: doc.artifact_version,
        model_schema: doc.model_schema,
        workbook_graph: doc.workbook_graph,
        workbook_snapshot: doc.workbook_snapshot,
      }))
    : sha256(scenario.rows[0].model_version_hash);

  const context = input.workspaceId
    ? await client.query<{ context_data: Record<string, unknown> }>(
        `SELECT context_data FROM company_context
         WHERE workspace_id = $1 AND status = 'active'
         ORDER BY created_at DESC LIMIT 1`,
        [input.workspaceId],
      )
    : { rows: [] };
  const ctx = context.rows[0]?.context_data ?? {};
  const denomination = {
    currency: ctx.currency ?? "USD",
    canonical_unit: ctx.canonical_unit ?? "Million",
    display_unit: ctx.currency_unit ?? ctx.canonical_unit ?? "Million",
  };

  const levers = params.rows.map((parameter) => ({
    id: parameter.parameter_id,
    label: parameter.extracted_name,
    variable_id: parameter.mapped_variable_id,
    base: parameter.base_value == null ? null : Number(parameter.base_value),
    scenario_value: Number(parameter.scenario_value),
    resolved_absolute: input.resolvedVariables[parameter.mapped_variable_id] ?? null,
    delta_type: parameter.delta_type,
    status: parameter.status,
    binding_evidence: parameter.binding_evidence,
    owner_user_id: parameter.owner_user_id ?? null,
    source_citation: parameter.source_citation ?? null,
    rationale: parameter.rationale ?? null,
    effective_from: parameter.effective_from ?? null,
    review_status: parameter.review_status ?? null,
  }));

  const manifestId = randomUUID();
  const createdAt = new Date().toISOString();
  const engine = {
    hyperformula_version: hyperFormulaVersion,
    app_git_sha: process.env.APP_GIT_SHA || process.env.GIT_SHA || "unknown",
  };

  await client.query(
    `INSERT INTO run_manifest_chain_head (id, last_hash, last_manifest_id)
     VALUES (1, NULL, NULL) ON CONFLICT (id) DO NOTHING`,
  );
  const head = await client.query<{ last_hash: string | null }>(
    `SELECT last_hash FROM run_manifest_chain_head WHERE id = 1 FOR UPDATE`,
  );
  const prevHash = head.rows[0]?.last_hash ?? "";
  const payload = {
    manifest_id: manifestId,
    run_id: input.runId,
    scenario_id: input.scenarioId,
    scenario_version_id: input.scenarioVersionId,
    workspace_id: input.workspaceId,
    model_document_id: doc?.document_id ?? null,
    model_hash: modelHash,
    engine,
    levers,
    denomination,
    mc: input.mc ?? null,
    created_by: input.createdBy,
    created_at: createdAt,
  };
  const rowHash = computeChainHash(prevHash, canonicalManifestPayload(payload));

  const inserted = await client.query<RunManifestRow>(
    `INSERT INTO run_manifests (
       manifest_id, run_id, scenario_id, scenario_version_id, workspace_id,
       model_document_id, model_hash, engine, levers, denomination, mc,
       created_by, created_at, prev_hash, row_hash
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,
       $12,$13,$14,$15
     ) RETURNING *`,
    [
      manifestId,
      input.runId,
      input.scenarioId,
      input.scenarioVersionId,
      input.workspaceId,
      doc?.document_id ?? null,
      modelHash,
      JSON.stringify(engine),
      JSON.stringify(levers),
      JSON.stringify(denomination),
      input.mc == null ? null : JSON.stringify(input.mc),
      input.createdBy,
      createdAt,
      prevHash,
      rowHash,
    ],
  );
  await client.query(
    `UPDATE run_manifest_chain_head
     SET last_hash = $1, last_manifest_id = $2 WHERE id = 1`,
    [rowHash, manifestId],
  );
  return inserted.rows[0];
}

export async function verifyManifestChain(): Promise<ManifestChainVerifyResult> {
  const rows = await pool.query<RunManifestRow>(
    `SELECT * FROM run_manifests ORDER BY created_at ASC, manifest_id ASC`,
  );
  let expectedPrev = "";
  let checked = 0;
  for (const row of rows.rows) {
    checked++;
    if ((row.prev_hash ?? "") !== expectedPrev) {
      return {
        valid: false,
        checked,
        firstBadId: row.manifest_id,
        reason: "prev_hash mismatch",
      };
    }
    const createdAt = new Date(row.created_at).toISOString();
    const expectedHash = computeChainHash(
      expectedPrev,
      canonicalManifestPayload({ ...row, created_at: createdAt }),
    );
    if (expectedHash !== row.row_hash) {
      return {
        valid: false,
        checked,
        firstBadId: row.manifest_id,
        reason: "row_hash does not match canonical payload",
      };
    }
    expectedPrev = row.row_hash;
  }
  return { valid: true, checked };
}
