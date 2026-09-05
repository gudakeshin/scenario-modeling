/**
 * Workspace service — per-user containers that isolate documents,
 * company context / models, and scenarios from each other.
 */

import { pool } from "../db/index.js";
import { logger } from "../logger.js";

export interface Workspace {
  workspace_id: string;
  owner_id: string;
  name: string;
  is_default: boolean;
  status: string;
  created_at: string;
  updated_at: string;
  document_count?: number;
  scenario_count?: number;
  sensitivity?: "public" | "confidential" | "upsi";
  nature_of_upsi?: string | null;
  organization_id?: string | null;
  trading_window_status?: "open" | "closed" | null;
  trading_window_from?: string | null;
  trading_window_until?: string | null;
  trading_window_note?: string | null;
}

function httpError(message: string, status: number): Error {
  return Object.assign(new Error(message), { status });
}

/**
 * Return the user's default workspace id, creating it if missing
 * (covers users registered before the workspace feature or via paths
 * that don't create one).
 */
export async function ensureDefaultWorkspace(userId: string): Promise<string> {
  const existing = await pool.query(
    `SELECT workspace_id FROM workspaces
     WHERE owner_id = $1 AND is_default AND status = 'active' LIMIT 1`,
    [userId]
  );
  if (existing.rows[0]) {
    await pool.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, granted_by, access_reason)
       VALUES ($1, $2, $2, 'Workspace owner')
       ON CONFLICT (workspace_id, user_id) DO NOTHING`,
      [existing.rows[0].workspace_id, userId],
    );
    return existing.rows[0].workspace_id;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const inserted = await client.query(
      `INSERT INTO workspaces (owner_id, name, is_default) VALUES ($1, 'Default', TRUE)
       RETURNING workspace_id`,
      [userId]
    );
    await client.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, granted_by, access_reason)
       VALUES ($1, $2, $2, 'Workspace owner')
       ON CONFLICT (workspace_id, user_id) DO NOTHING`,
      [inserted.rows[0].workspace_id, userId],
    );
    await client.query("COMMIT");
    return inserted.rows[0].workspace_id;
  } catch (e) {
    await client.query("ROLLBACK");
    // Race with a concurrent request: the partial unique index on
    // (owner_id) WHERE is_default rejected our insert — re-read and
    // still ensure owner membership exists.
    const retry = await pool.query(
      `SELECT workspace_id FROM workspaces
       WHERE owner_id = $1 AND is_default AND status = 'active' LIMIT 1`,
      [userId]
    );
    if (retry.rows[0]) {
      await pool.query(
        `INSERT INTO workspace_memberships (workspace_id, user_id, granted_by, access_reason)
         VALUES ($1, $2, $2, 'Workspace owner')
         ON CONFLICT (workspace_id, user_id) DO NOTHING`,
        [retry.rows[0].workspace_id, userId],
      );
      return retry.rows[0].workspace_id;
    }
    throw e;
  } finally {
    client.release();
  }
}

export async function listWorkspaces(userId: string): Promise<Workspace[]> {
  // Ensure every user always has at least their default workspace listed.
  await ensureDefaultWorkspace(userId);
  const r = await pool.query(
    `SELECT w.workspace_id, w.owner_id, w.name, w.is_default, w.status,
            w.sensitivity, w.nature_of_upsi, w.organization_id,
            o.trading_window_status, o.trading_window_from, o.trading_window_until,
            o.trading_window_note, w.created_at, w.updated_at,
            (SELECT COUNT(*)::int FROM documents d WHERE d.workspace_id = w.workspace_id) AS document_count,
            (SELECT COUNT(*)::int FROM scenarios s WHERE s.workspace_id = w.workspace_id) AS scenario_count
     FROM workspaces w
     LEFT JOIN organizations o ON o.organization_id = w.organization_id
     WHERE w.status = 'active'
       AND (w.owner_id = $1 OR EXISTS (
         SELECT 1 FROM workspace_memberships wm
         WHERE wm.workspace_id = w.workspace_id AND wm.user_id = $1
       ))
     ORDER BY w.is_default DESC, w.created_at ASC`,
    [userId]
  );
  return r.rows;
}

export async function getWorkspace(userId: string, workspaceId: string): Promise<Workspace | null> {
  const r = await pool.query(
    `SELECT workspace_id, owner_id, name, is_default, status, created_at, updated_at
     FROM workspaces WHERE workspace_id = $1 AND owner_id = $2 AND status = 'active'`,
    [workspaceId, userId]
  );
  return r.rows[0] ?? null;
}

export async function createWorkspace(userId: string, name: string): Promise<Workspace> {
  const trimmed = (name ?? "").trim();
  if (!trimmed) throw httpError("Workspace name is required", 400);
  if (trimmed.length > 255) throw httpError("Workspace name too long (max 255 characters)", 400);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const r = await client.query(
      `INSERT INTO workspaces (owner_id, name) VALUES ($1, $2)
       RETURNING workspace_id, owner_id, name, is_default, status, created_at, updated_at`,
      [userId, trimmed]
    );
    await client.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, granted_by, access_reason)
       VALUES ($1, $2, $2, 'Workspace owner')`,
      [r.rows[0].workspace_id, userId],
    );
    await client.query("COMMIT");
    return r.rows[0];
  } catch (e) {
    await client.query("ROLLBACK");
    if ((e as { code?: string }).code === "23505") {
      throw httpError(`A workspace named "${trimmed}" already exists`, 409);
    }
    throw e;
  } finally {
    client.release();
  }
}

export async function renameWorkspace(userId: string, workspaceId: string, name: string): Promise<Workspace> {
  const trimmed = (name ?? "").trim();
  if (!trimmed) throw httpError("Workspace name is required", 400);
  if (trimmed.length > 255) throw httpError("Workspace name too long (max 255 characters)", 400);
  try {
    const r = await pool.query(
      `UPDATE workspaces SET name = $3, updated_at = NOW()
       WHERE workspace_id = $1 AND owner_id = $2 AND status = 'active'
       RETURNING workspace_id, owner_id, name, is_default, status, created_at, updated_at`,
      [workspaceId, userId, trimmed]
    );
    if (!r.rows[0]) throw httpError("Workspace not found", 404);
    return r.rows[0];
  } catch (e) {
    if ((e as { code?: string }).code === "23505") {
      throw httpError(`A workspace named "${trimmed}" already exists`, 409);
    }
    throw e;
  }
}

/**
 * Delete a workspace and its contents:
 * - documents hard-deleted (chunks cascade via FK; file_bytes dominate storage)
 * - company_context marked deleted, user_models deactivated
 * - scenarios archived only — audit_trail rows are immutable (no-delete trigger)
 *   and reference scenarios without cascade, so hard deletion is impossible
 * - sharing rows removed so recipients no longer see archived scenarios
 * - the workspace itself is soft-deleted
 */
export async function deleteWorkspace(userId: string, workspaceId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const ws = await client.query(
      `SELECT workspace_id, is_default FROM workspaces
       WHERE workspace_id = $1 AND owner_id = $2 AND status = 'active' FOR UPDATE`,
      [workspaceId, userId]
    );
    if (!ws.rows[0]) throw httpError("Workspace not found", 404);

    const others = await client.query(
      `SELECT workspace_id FROM workspaces
       WHERE owner_id = $1 AND status = 'active' AND workspace_id <> $2
       ORDER BY created_at ASC`,
      [userId, workspaceId]
    );
    if (others.rows.length === 0) {
      throw httpError("Cannot delete your last workspace", 400);
    }

    const storedObjects = await client.query<{ storage_key: string }>(
      `SELECT storage_key FROM documents
       WHERE workspace_id = $1 AND storage_key IS NOT NULL`,
      [workspaceId],
    );

    await client.query(`DELETE FROM documents WHERE workspace_id = $1`, [workspaceId]);
    await client.query(
      `UPDATE company_context SET status = 'deleted', updated_at = NOW() WHERE workspace_id = $1`,
      [workspaceId]
    );
    await client.query(
      `UPDATE user_models SET is_active = FALSE, updated_at = NOW() WHERE workspace_id = $1`,
      [workspaceId]
    );
    await client.query(
      `DELETE FROM scenario_sharing WHERE scenario_id IN (SELECT scenario_id FROM scenarios WHERE workspace_id = $1)`,
      [workspaceId]
    );
    await client.query(
      `UPDATE scenarios SET status = 'archived', updated_at = NOW() WHERE workspace_id = $1`,
      [workspaceId]
    );
    await client.query(
      `UPDATE workspaces SET status = 'deleted', is_default = FALSE, updated_at = NOW() WHERE workspace_id = $1`,
      [workspaceId]
    );

    // If the default workspace was deleted, promote the oldest remaining one.
    if (ws.rows[0].is_default) {
      await client.query(
        `UPDATE workspaces SET is_default = TRUE, updated_at = NOW() WHERE workspace_id = $1`,
        [others.rows[0].workspace_id]
      );
    }

    await client.query("COMMIT");

    if (storedObjects.rows.length > 0) {
      try {
        const { deleteObject } = await import("./objectStorage.js");
        for (const row of storedObjects.rows) {
          try {
            await deleteObject(row.storage_key);
          } catch (e) {
            logger.warn(
              { detail: (e as Error).message, workspaceId, key: row.storage_key },
              "Workspace delete: object storage cleanup skipped",
            );
          }
        }
      } catch (e) {
        logger.warn(
          { detail: (e as Error).message, workspaceId },
          "Workspace delete: object storage module unavailable",
        );
      }
    }

    logger.info({ workspaceId, userId }, "Workspace deleted");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
