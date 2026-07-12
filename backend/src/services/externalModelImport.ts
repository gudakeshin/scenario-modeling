/**
 * External model import — async in-process job polled via snapshot status.
 * Phase A: persist metadata verbatim + stream facts.
 * Phase C hook: map + activate user_models (see activateExternalModel).
 */

import { pool } from "../db/index.js";
import { config } from "../config.js";
import { createConnector } from "../connectors/registry.js";
import type { FactQuery, PlanningModelMetadata } from "../connectors/types.js";
import {
  getConnectionWithSecret,
  writeIntegrationEvent,
  ConnectionError,
} from "./connectionService.js";
import type { Scope } from "../middleware/workspace.js";
import { logger } from "../logger.js";

export interface SnapshotPublic {
  snapshot_id: string;
  connection_id: string;
  workspace_id: string;
  provider: string;
  external_model_id: string;
  external_model_name: string;
  snapshot_version: number;
  status: string;
  error: string | null;
  metadata: PlanningModelMetadata | Record<string, unknown>;
  stats: Record<string, unknown>;
  fact_query: FactQuery | null;
  created_at: string;
  updated_at: string;
}

const SNAPSHOT_COLUMNS = `
  snapshot_id, connection_id, workspace_id, provider, external_model_id,
  external_model_name, snapshot_version, status, error, metadata, stats,
  fact_query, created_at, updated_at
`;

export async function getSnapshot(
  workspaceId: string,
  snapshotId: string,
): Promise<SnapshotPublic | null> {
  const r = await pool.query(
    `SELECT ${SNAPSHOT_COLUMNS}
     FROM external_model_snapshots
     WHERE workspace_id = $1 AND snapshot_id = $2`,
    [workspaceId, snapshotId],
  );
  return (r.rows[0] as SnapshotPublic | undefined) ?? null;
}

export async function listSnapshots(
  workspaceId: string,
  connectionId: string | undefined,
  limit: number,
): Promise<SnapshotPublic[]> {
  const values: unknown[] = [workspaceId];
  let connectionFilter = "";
  if (connectionId) {
    values.push(connectionId);
    connectionFilter = ` AND connection_id = $${values.length}`;
  }
  values.push(limit);
  const r = await pool.query(
    `SELECT ${SNAPSHOT_COLUMNS}
     FROM external_model_snapshots
     WHERE workspace_id = $1${connectionFilter}
     ORDER BY created_at DESC
     LIMIT $${values.length}`,
    values,
  );
  return r.rows as SnapshotPublic[];
}

async function nextSnapshotVersion(
  connectionId: string,
  externalModelId: string,
): Promise<number> {
  const r = await pool.query(
    `SELECT COALESCE(MAX(snapshot_version), 0) + 1 AS v
     FROM external_model_snapshots
     WHERE connection_id = $1 AND external_model_id = $2`,
    [connectionId, externalModelId],
  );
  return Number(r.rows[0].v);
}

/**
 * Start an async import. Returns the snapshot_id immediately (status=importing).
 */
export async function startImport(
  scope: Scope,
  connectionId: string,
  externalModelId: string,
  factQuery: FactQuery,
): Promise<{ snapshot_id: string }> {
  const conn = await getConnectionWithSecret(scope.workspaceId, connectionId);
  if (!conn) throw new ConnectionError("Connection not found", 404);

  const connector = createConnector(conn);
  let modelName = externalModelId;
  try {
    const models = await connector.listModels();
    const hit = models.find((m) => m.id === externalModelId);
    if (hit) modelName = hit.name;
  } catch {
    // name is best-effort
  }

  const version = await nextSnapshotVersion(connectionId, externalModelId);
  const r = await pool.query(
    `INSERT INTO external_model_snapshots
       (connection_id, workspace_id, provider, external_model_id, external_model_name,
        snapshot_version, status, fact_query)
     VALUES ($1, $2, $3, $4, $5, $6, 'importing', $7)
     RETURNING snapshot_id`,
    [
      connectionId,
      scope.workspaceId,
      conn.provider,
      externalModelId,
      modelName,
      version,
      JSON.stringify(factQuery),
    ],
  );
  const snapshotId = r.rows[0].snapshot_id as string;

  await writeIntegrationEvent({
    workspaceId: scope.workspaceId,
    connectionId,
    userId: scope.userId,
    eventType: "import.started",
    details: { snapshot_id: snapshotId, external_model_id: externalModelId, version },
  });

  // Fire-and-forget in-process job
  void runImportJob(scope, connectionId, snapshotId, externalModelId, factQuery).catch((e) => {
    logger.error({ err: e, snapshotId }, "Import job crashed");
  });

  return { snapshot_id: snapshotId };
}

async function runImportJob(
  scope: Scope,
  connectionId: string,
  snapshotId: string,
  externalModelId: string,
  factQuery: FactQuery,
): Promise<void> {
  const maxCells = config.EXTERNAL_MODEL_MAX_CELLS;
  try {
    const conn = await getConnectionWithSecret(scope.workspaceId, connectionId);
    if (!conn) throw new Error("Connection disappeared during import");

    const connector = createConnector(conn);
    const metadata = await connector.getModelMetadata(externalModelId);

    await pool.query(
      `UPDATE external_model_snapshots
       SET metadata = $1, updated_at = NOW()
       WHERE snapshot_id = $2`,
      [JSON.stringify(metadata), snapshotId],
    );

    let cellCount = 0;
    const batch: Array<[string, string, string, number]> = [];
    const FLUSH = 500;

    async function flush(): Promise<void> {
      if (batch.length === 0) return;
      const values: unknown[] = [];
      const placeholders: string[] = [];
      let i = 1;
      for (const [sid, mid, key, val] of batch) {
        placeholders.push(`($${i++}, $${i++}, $${i++}, $${i++})`);
        values.push(sid, mid, key, val);
      }
      await pool.query(
        `INSERT INTO external_model_facts (snapshot_id, measure_id, member_key, value)
         VALUES ${placeholders.join(",")}
         ON CONFLICT (snapshot_id, measure_id, member_key)
         DO UPDATE SET value = EXCLUDED.value`,
        values,
      );
      batch.length = 0;
    }

    for await (const page of connector.getModelData(externalModelId, factQuery)) {
      for (const row of page.rows) {
        cellCount += 1;
        if (cellCount > maxCells) {
          throw new Error(
            `Import exceeded EXTERNAL_MODEL_MAX_CELLS (${maxCells}). Narrow the fact query scope.`,
          );
        }
        batch.push([snapshotId, row.measureId, row.memberKey, row.value]);
        if (batch.length >= FLUSH) await flush();
      }
    }
    await flush();

    // Persist source_aggregates collected during FactData streaming (SAC)
    const refreshedMeta = await connector.getModelMetadata(externalModelId);
    if (refreshedMeta.source_aggregates?.length) {
      metadata.source_aggregates = refreshedMeta.source_aggregates;
    }
    await pool.query(
      `UPDATE external_model_snapshots
       SET metadata = $1, updated_at = NOW()
       WHERE snapshot_id = $2`,
      [JSON.stringify(metadata), snapshotId],
    );

    const stats = {
      fact_count: cellCount,
      dimension_count: metadata.dimensions.length,
      measure_count: metadata.measures.length,
      source_aggregate_count: metadata.source_aggregates?.length ?? 0,
      imported_at: new Date().toISOString(),
    };

    const { activateExternalModel } = await import("./externalModelMapping.js");
    await activateExternalModel(scope, snapshotId, stats);

    await writeIntegrationEvent({
      workspaceId: scope.workspaceId,
      connectionId,
      userId: scope.userId,
      eventType: "import.completed",
      details: { snapshot_id: snapshotId, stats },
    });
  } catch (e) {
    const msg = (e as Error).message;
    await pool.query(
      `UPDATE external_model_snapshots
       SET status = 'failed', error = $1, updated_at = NOW()
       WHERE snapshot_id = $2`,
      [msg, snapshotId],
    );
    await writeIntegrationEvent({
      workspaceId: scope.workspaceId,
      connectionId,
      userId: scope.userId,
      eventType: "import.failed",
      details: { snapshot_id: snapshotId, error: msg },
    });
  }
}

/**
 * Refresh: re-import with stored fact_query; supersede prior ready snapshots
 * for the same connection+model; activate new user_models row (Phase C).
 */
export async function refreshImport(
  scope: Scope,
  snapshotId: string,
): Promise<{ snapshot_id: string }> {
  const existing = await getSnapshot(scope.workspaceId, snapshotId);
  if (!existing) throw new ConnectionError("Snapshot not found", 404);
  if (!existing.fact_query) {
    throw new ConnectionError("Snapshot has no stored fact_query to refresh", 400);
  }

  const result = await startImport(
    scope,
    existing.connection_id,
    existing.external_model_id,
    existing.fact_query,
  );

  return result;
}
