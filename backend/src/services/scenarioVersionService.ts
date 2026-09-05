/**
 * Persisted scenario version snapshots + lineage diffs.
 */

import { pool } from "../db/index.js";
import { getScenarioContext, getTouchedLeverSnapshot } from "./scenarioContextService.js";
import type { PoolClient } from "pg";

export interface ScenarioVersionRow {
  version_id: string;
  scenario_id: string;
  workspace_id: string | null;
  label: string;
  version_number: number;
  touched_levers: unknown;
  parameters_snapshot: unknown;
  outputs: Record<string, number>;
  created_by: string | null;
  created_at: string;
}

export async function createScenarioVersion(
  scenarioId: string,
  opts: {
    label?: string;
    outputs: Record<string, number>;
    userId?: string;
    workspaceId?: string | null;
  },
  client?: PoolClient,
): Promise<ScenarioVersionRow> {
  const db = client ?? pool;
  const maxRes = await db.query(
    `SELECT COALESCE(MAX(version_number), 0) AS n FROM scenario_versions WHERE scenario_id = $1`,
    [scenarioId],
  );
  const next = Number(maxRes.rows[0]?.n || 0) + 1;
  const label = opts.label || `v${next}`;
  const levers = getTouchedLeverSnapshot(scenarioId);
  const params = await db.query(
    `SELECT extracted_name, mapped_variable_id, scenario_value, delta_type, status
     FROM scenario_parameters WHERE scenario_id = $1 AND status != 'rejected'`,
    [scenarioId],
  );

  const r = await db.query(
    `INSERT INTO scenario_versions (
       scenario_id, workspace_id, label, version_number,
       touched_levers, parameters_snapshot, outputs, created_by
     ) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8)
     RETURNING *`,
    [
      scenarioId,
      opts.workspaceId ?? null,
      label,
      next,
      JSON.stringify(levers),
      JSON.stringify(params.rows),
      JSON.stringify(opts.outputs),
      opts.userId ?? null,
    ],
  );
  return r.rows[0] as ScenarioVersionRow;
}

export async function listScenarioVersions(scenarioId: string): Promise<ScenarioVersionRow[]> {
  const r = await pool.query(
    `SELECT * FROM scenario_versions WHERE scenario_id = $1 ORDER BY version_number DESC`,
    [scenarioId],
  );
  return r.rows as ScenarioVersionRow[];
}

export async function diffScenarioVersions(
  scenarioId: string,
  fromVersion: number,
  toVersion: number,
): Promise<{
  from: ScenarioVersionRow | null;
  to: ScenarioVersionRow | null;
  output_deltas: Record<string, { from: number | null; to: number | null; delta: number | null }>;
}> {
  const r = await pool.query(
    `SELECT * FROM scenario_versions
     WHERE scenario_id = $1 AND version_number = ANY($2::int[])`,
    [scenarioId, [fromVersion, toVersion]],
  );
  const byNum = new Map(r.rows.map((row: ScenarioVersionRow) => [row.version_number, row]));
  const from = byNum.get(fromVersion) ?? null;
  const to = byNum.get(toVersion) ?? null;
  const keys = new Set([
    ...Object.keys((from?.outputs as Record<string, number>) || {}),
    ...Object.keys((to?.outputs as Record<string, number>) || {}),
  ]);
  const output_deltas: Record<
    string,
    { from: number | null; to: number | null; delta: number | null }
  > = {};
  for (const k of keys) {
    const a = (from?.outputs as Record<string, number> | undefined)?.[k] ?? null;
    const b = (to?.outputs as Record<string, number> | undefined)?.[k] ?? null;
    output_deltas[k] = {
      from: a,
      to: b,
      delta: a != null && b != null ? b - a : null,
    };
  }
  return { from, to, output_deltas };
}

/** Backfill comparisonVersions from in-memory/context_data into scenario_versions. */
export async function migrateComparisonVersionsFromContext(scenarioId: string): Promise<number> {
  const ctx = getScenarioContext(scenarioId);
  if (!ctx?.comparisonVersions?.length) return 0;
  let n = 0;
  for (const v of ctx.comparisonVersions) {
    await createScenarioVersion(scenarioId, {
      label: v.label,
      outputs: v.outputs,
    });
    n++;
  }
  return n;
}
