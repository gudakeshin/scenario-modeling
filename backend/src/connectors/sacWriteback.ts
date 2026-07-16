/**
 * SAP SAC plan write-back — push approved scenario deltas to a planning version.
 * Requires scenario status=approved and idempotency via integration_events.request_id.
 */

import { pool } from "../db/index.js";
import { createConnector, type ConnectionRow } from "./registry.js";
import { logger } from "../logger.js";
import { fetchWithTimeout } from "./http.js";

export interface SacWritebackRequest {
  connection_id: string;
  workspace_id: string;
  scenario_id: string;
  user_id: string;
  target_version_member?: string;
  measure_values: Array<{ measure_id: string; member_key: string; value: number }>;
  idempotency_key: string;
}

export interface SacWritebackResult {
  ok: boolean;
  written: number;
  skipped_duplicate?: boolean;
  event_id?: string;
  message?: string;
}

export async function writeBackToSac(req: SacWritebackRequest): Promise<SacWritebackResult> {
  if (!req.idempotency_key || req.idempotency_key.length < 8) {
    throw Object.assign(new Error("idempotency_key is required (min 8 chars)"), { status: 400 });
  }

  // Approval gate — only approved (or already completed) scenarios may write back
  const scenario = await pool.query(
    `SELECT scenario_id, status, workspace_id FROM scenarios WHERE scenario_id = $1`,
    [req.scenario_id],
  );
  if (!scenario.rows[0]) {
    throw Object.assign(new Error("Scenario not found"), { status: 404 });
  }
  const status = String(scenario.rows[0].status || "");
  if (status !== "approved" && status !== "completed") {
    throw Object.assign(
      new Error("Scenario must be approved before SAC write-back"),
      { status: 400 },
    );
  }
  if (
    scenario.rows[0].workspace_id &&
    scenario.rows[0].workspace_id !== req.workspace_id
  ) {
    throw Object.assign(new Error("Scenario does not belong to this workspace"), { status: 403 });
  }

  // Idempotency check
  const existing = await pool.query(
    `SELECT event_id FROM integration_events
     WHERE workspace_id = $1 AND request_id = $2 AND event_type = 'sac_writeback'
     LIMIT 1`,
    [req.workspace_id, req.idempotency_key],
  );
  if (existing.rows.length > 0) {
    return {
      ok: true,
      written: 0,
      skipped_duplicate: true,
      event_id: existing.rows[0].event_id,
      message: "Write-back already applied for this idempotency key",
    };
  }

  const connRes = await pool.query(
    `SELECT * FROM planning_connections
     WHERE connection_id = $1 AND workspace_id = $2 AND status = 'active'`,
    [req.connection_id, req.workspace_id],
  );
  if (connRes.rows.length === 0) {
    throw Object.assign(new Error("Planning connection not found"), { status: 404 });
  }
  const row = connRes.rows[0] as ConnectionRow;
  if (row.provider !== "sap_sac") {
    throw Object.assign(new Error("Write-back currently supported for sap_sac only"), {
      status: 400,
    });
  }

  // Connector is read-oriented today; write-back posts to SAC Data Import / planning API
  // using the same auth. Soft-fail with audited event when endpoint not configured.
  const connector = createConnector(row);
  const test = await connector.testConnection();
  if (!test.ok) {
    throw Object.assign(new Error(`SAC connection unhealthy: ${test.message}`), { status: 502 });
  }

  const authPublic = row.auth_public || {};
  const writeUrl = String(authPublic.writeback_url || authPublic.writeBackUrl || "");
  let written = 0;
  let message = "Write-back recorded (dry-run — configure auth_public.writeback_url for live push)";

  if (writeUrl) {
    try {
      const secretPlain = (await import("../services/secretVault.js")).decryptSecret(
        row.secret_ciphertext,
      );
      // Minimal bearer / client-credentials POST of fact payload
      const res = await fetchWithTimeout(writeUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${secretPlain}`,
          "Idempotency-Key": req.idempotency_key,
        },
        body: JSON.stringify({
          scenario_id: req.scenario_id,
          version: req.target_version_member,
          facts: req.measure_values,
        }),
      });
      if (!res.ok) {
        throw new Error(`SAC write-back HTTP ${res.status}`);
      }
      written = req.measure_values.length;
      message = "Write-back accepted by SAC";
    } catch (e) {
      logger.error({ err: e }, "[SAC write-back] failed");
      throw Object.assign(new Error(`SAC write-back failed: ${(e as Error).message}`), {
        status: 502,
      });
    }
  }

  const event = await pool.query(
    `INSERT INTO integration_events (
       workspace_id, connection_id, user_id, event_type, details, request_id
     ) VALUES ($1, $2, $3, 'sac_writeback', $4::jsonb, $5)
     RETURNING event_id`,
    [
      req.workspace_id,
      req.connection_id,
      req.user_id,
      JSON.stringify({
        scenario_id: req.scenario_id,
        written,
        dry_run: !writeUrl,
        measure_count: req.measure_values.length,
        target_version_member: req.target_version_member,
      }),
      req.idempotency_key,
    ],
  );

  return {
    ok: true,
    written,
    event_id: event.rows[0].event_id,
    message,
  };
}
