/**
 * Planning connection CRUD + browse + integration event logging.
 * Secrets are encrypted at rest and never returned in API responses.
 */

import { pool } from "../db/index.js";
import { createConnector, type ConnectionRow } from "../connectors/registry.js";
import type { FactQuery, PlanningModelMetadata, PlanningModelSummary } from "../connectors/types.js";
import { encryptSecret } from "./secretVault.js";
import { getRequestContext } from "../requestContext.js";
import type { Scope } from "../middleware/workspace.js";
import type { CreateConnectionBody, UpdateConnectionBody } from "../schemas/connections.js";

/** Explicit public columns — never SELECT *. */
export const CONNECTION_PUBLIC_COLUMNS = `
  connection_id, workspace_id, created_by, provider, name, base_url,
  auth_kind, auth_public, status, last_test_at, last_test_ok, created_at, updated_at
`;

export interface ConnectionPublic {
  connection_id: string;
  workspace_id: string;
  created_by: string;
  provider: string;
  name: string;
  base_url: string;
  auth_kind: string;
  auth_public: Record<string, unknown>;
  status: string;
  last_test_at: string | null;
  last_test_ok: boolean | null;
  created_at: string;
  updated_at: string;
}

export class ConnectionError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export async function writeIntegrationEvent(opts: {
  workspaceId: string;
  connectionId?: string | null;
  userId?: string | null;
  eventType: string;
  details?: Record<string, unknown>;
}): Promise<void> {
  const ctx = getRequestContext();
  await pool.query(
    `INSERT INTO integration_events
       (workspace_id, connection_id, user_id, event_type, details, request_id, ip_address)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      opts.workspaceId,
      opts.connectionId ?? null,
      opts.userId ?? null,
      opts.eventType,
      JSON.stringify(opts.details ?? {}),
      ctx?.requestId ?? null,
      ctx?.ip ?? null,
    ],
  );
}

export async function createConnection(
  scope: Scope,
  body: CreateConnectionBody,
): Promise<ConnectionPublic> {
  const ciphertext = encryptSecret(body.secret);
  try {
    const r = await pool.query(
      `INSERT INTO planning_connections
         (workspace_id, created_by, provider, name, base_url, auth_kind, auth_public, secret_ciphertext)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING ${CONNECTION_PUBLIC_COLUMNS}`,
      [
        scope.workspaceId,
        scope.userId,
        body.provider,
        body.name,
        body.base_url,
        body.auth_kind,
        JSON.stringify(body.auth_public ?? {}),
        ciphertext,
      ],
    );
    const row = r.rows[0] as ConnectionPublic;
    await writeIntegrationEvent({
      workspaceId: scope.workspaceId,
      connectionId: row.connection_id,
      userId: scope.userId,
      eventType: "connection.created",
      details: { provider: body.provider, name: body.name },
    });
    return row;
  } catch (e: unknown) {
    if ((e as { code?: string }).code === "23505") {
      throw new ConnectionError("A connection with this name already exists in the workspace", 409);
    }
    throw e;
  }
}

export async function listConnections(workspaceId: string): Promise<ConnectionPublic[]> {
  const r = await pool.query(
    `SELECT ${CONNECTION_PUBLIC_COLUMNS}
     FROM planning_connections
     WHERE workspace_id = $1 AND status = 'active'
     ORDER BY created_at DESC`,
    [workspaceId],
  );
  return r.rows as ConnectionPublic[];
}

export async function getConnection(
  workspaceId: string,
  connectionId: string,
): Promise<ConnectionPublic | null> {
  const r = await pool.query(
    `SELECT ${CONNECTION_PUBLIC_COLUMNS}
     FROM planning_connections
     WHERE workspace_id = $1 AND connection_id = $2`,
    [workspaceId, connectionId],
  );
  return (r.rows[0] as ConnectionPublic | undefined) ?? null;
}

export async function listIntegrationEvents(
  workspaceId: string,
  connectionId: string,
  limit: number,
  offset: number,
): Promise<Array<Record<string, unknown>>> {
  const connection = await getConnection(workspaceId, connectionId);
  if (!connection) throw new ConnectionError("Connection not found", 404);
  const r = await pool.query(
    `SELECT event_id, workspace_id, connection_id, user_id, event_type, details,
            request_id, ip_address, created_at
     FROM integration_events
     WHERE workspace_id = $1 AND connection_id = $2
     ORDER BY created_at DESC
     LIMIT $3 OFFSET $4`,
    [workspaceId, connectionId, limit, offset],
  );
  return r.rows as Array<Record<string, unknown>>;
}

/** Internal: load row including ciphertext for connector construction. */
export async function getConnectionWithSecret(
  workspaceId: string,
  connectionId: string,
): Promise<ConnectionRow | null> {
  const r = await pool.query(
    `SELECT connection_id, workspace_id, provider, name, base_url, auth_kind,
            auth_public, secret_ciphertext, status
     FROM planning_connections
     WHERE workspace_id = $1 AND connection_id = $2 AND status = 'active'`,
    [workspaceId, connectionId],
  );
  return (r.rows[0] as ConnectionRow | undefined) ?? null;
}

export async function updateConnection(
  scope: Scope,
  connectionId: string,
  body: UpdateConnectionBody,
): Promise<ConnectionPublic> {
  const existing = await getConnectionWithSecret(scope.workspaceId, connectionId);
  if (!existing) throw new ConnectionError("Connection not found", 404);

  const name = body.name ?? existing.name;
  const baseUrl = body.base_url ?? existing.base_url;
  const authKind = body.auth_kind ?? existing.auth_kind;
  const authPublic = body.auth_public ?? existing.auth_public;
  const ciphertext = body.secret
    ? encryptSecret(body.secret)
    : existing.secret_ciphertext;

  try {
    const r = await pool.query(
      `UPDATE planning_connections
       SET name = $1, base_url = $2, auth_kind = $3, auth_public = $4,
           secret_ciphertext = $5, updated_at = NOW()
       WHERE connection_id = $6 AND workspace_id = $7
       RETURNING ${CONNECTION_PUBLIC_COLUMNS}`,
      [
        name,
        baseUrl,
        authKind,
        JSON.stringify(authPublic),
        ciphertext,
        connectionId,
        scope.workspaceId,
      ],
    );
    await writeIntegrationEvent({
      workspaceId: scope.workspaceId,
      connectionId,
      userId: scope.userId,
      eventType: "connection.updated",
      details: { secret_rotated: !!body.secret },
    });
    return r.rows[0] as ConnectionPublic;
  } catch (e: unknown) {
    if ((e as { code?: string }).code === "23505") {
      throw new ConnectionError("A connection with this name already exists in the workspace", 409);
    }
    throw e;
  }
}

export async function deleteConnection(scope: Scope, connectionId: string): Promise<void> {
  const existing = await getConnection(scope.workspaceId, connectionId);
  if (!existing) throw new ConnectionError("Connection not found", 404);

  const snapCount = await pool.query(
    `SELECT COUNT(*)::int AS n FROM external_model_snapshots WHERE connection_id = $1`,
    [connectionId],
  );
  const hasSnapshots = (snapCount.rows[0]?.n ?? 0) > 0;

  if (hasSnapshots) {
    await pool.query(
      `UPDATE planning_connections SET status = 'disabled', updated_at = NOW()
       WHERE connection_id = $1 AND workspace_id = $2`,
      [connectionId, scope.workspaceId],
    );
    await writeIntegrationEvent({
      workspaceId: scope.workspaceId,
      connectionId,
      userId: scope.userId,
      eventType: "connection.disabled",
    });
  } else {
    // Write before deletion so the FK's ON DELETE SET NULL preserves the event.
    await writeIntegrationEvent({
      workspaceId: scope.workspaceId,
      connectionId,
      userId: scope.userId,
      eventType: "connection.deleted",
    });
    await pool.query(
      `DELETE FROM planning_connections WHERE connection_id = $1 AND workspace_id = $2`,
      [connectionId, scope.workspaceId],
    );
  }
}

export async function testConnection(
  scope: Scope,
  connectionId: string,
): Promise<{ ok: boolean; message?: string }> {
  const row = await getConnectionWithSecret(scope.workspaceId, connectionId);
  if (!row) throw new ConnectionError("Connection not found", 404);

  const connector = createConnector(row);
  const result = await connector.testConnection();

  await pool.query(
    `UPDATE planning_connections
     SET last_test_at = NOW(), last_test_ok = $1, updated_at = NOW()
     WHERE connection_id = $2`,
    [result.ok, connectionId],
  );
  await writeIntegrationEvent({
    workspaceId: scope.workspaceId,
    connectionId,
    userId: scope.userId,
    eventType: "connection.tested",
    details: { ok: result.ok, message: result.message },
  });
  return result;
}

export async function listModels(
  workspaceId: string,
  connectionId: string,
): Promise<PlanningModelSummary[]> {
  const row = await getConnectionWithSecret(workspaceId, connectionId);
  if (!row) throw new ConnectionError("Connection not found", 404);
  return createConnector(row).listModels();
}

export async function getModelMetadata(
  workspaceId: string,
  connectionId: string,
  modelId: string,
): Promise<PlanningModelMetadata> {
  const row = await getConnectionWithSecret(workspaceId, connectionId);
  if (!row) throw new ConnectionError("Connection not found", 404);
  return createConnector(row).getModelMetadata(modelId);
}

export type { FactQuery };
