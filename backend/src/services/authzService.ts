import { pool } from "../db/index.js";
import type { Role } from "../auth/provider.js";
import { assertOrgGateForWorkspace } from "./organizationService.js";

export type SharePermission = "view" | "edit";

async function getScenarioAccess(
  userId: string,
  role: Role,
  scenarioId: string,
): Promise<{
  exists: boolean;
  isOwner: boolean;
  permission: SharePermission | null;
  workspaceId: string | null;
}> {
  if (role === "admin") {
    const r = await pool.query(
      "SELECT creator_id, workspace_id FROM scenarios WHERE scenario_id = $1",
      [scenarioId],
    );
    if (!r.rows[0]) return { exists: false, isOwner: false, permission: null, workspaceId: null };
    return {
      exists: true,
      isOwner: r.rows[0].creator_id === userId,
      permission: "edit",
      workspaceId: r.rows[0].workspace_id ?? null,
    };
  }

  const r = await pool.query(
    `SELECT s.creator_id, s.workspace_id, ss.permission
     FROM scenarios s
     LEFT JOIN scenario_sharing ss
       ON ss.scenario_id = s.scenario_id AND ss.shared_with = $2
     WHERE s.scenario_id = $1`,
    [scenarioId, userId],
  );
  const row = r.rows[0];
  if (!row) return { exists: false, isOwner: false, permission: null, workspaceId: null };
  const isOwner = row.creator_id === userId;
  const permission: SharePermission | null = isOwner
    ? "edit"
    : (row.permission as SharePermission | null);
  return { exists: true, isOwner, permission, workspaceId: row.workspace_id ?? null };
}

export async function canReadScenario(
  userId: string,
  role: Role,
  scenarioId: string,
): Promise<boolean> {
  const access = await getScenarioAccess(userId, role, scenarioId);
  return access.exists && (access.isOwner || access.permission !== null || role === "admin");
}

export async function canWriteScenario(
  userId: string,
  role: Role,
  scenarioId: string,
): Promise<boolean> {
  const access = await getScenarioAccess(userId, role, scenarioId);
  if (!access.exists) return false;
  if (role === "admin" || access.isOwner) return true;
  return access.permission === "edit";
}

export async function assertCanReadScenario(
  userId: string,
  role: Role,
  scenarioId: string,
): Promise<void> {
  const access = await getScenarioAccess(userId, role, scenarioId);
  const ok = access.exists && (access.isOwner || access.permission !== null || role === "admin");
  if (!ok) {
    const exists = (
      await pool.query("SELECT 1 FROM scenarios WHERE scenario_id = $1", [scenarioId])
    ).rows[0];
    if (!exists) {
      throw Object.assign(new Error("Scenario not found"), { status: 404 });
    }
    throw Object.assign(new Error("Forbidden"), { status: 403 });
  }
  // Org gate: when workspace has organization_id, require org member or workspace owner
  await assertOrgGateForWorkspace(userId, access.workspaceId);
}

export async function assertCanWriteScenario(
  userId: string,
  role: Role,
  scenarioId: string,
): Promise<void> {
  const access = await getScenarioAccess(userId, role, scenarioId);
  let ok = false;
  if (access.exists) {
    if (role === "admin" || access.isOwner) ok = true;
    else ok = access.permission === "edit";
  }
  if (!ok) {
    const exists = (
      await pool.query("SELECT 1 FROM scenarios WHERE scenario_id = $1", [scenarioId])
    ).rows[0];
    if (!exists) {
      throw Object.assign(new Error("Scenario not found"), { status: 404 });
    }
    throw Object.assign(new Error("Forbidden"), { status: 403 });
  }
  await assertOrgGateForWorkspace(userId, access.workspaceId);
}

/**
 * SQL fragment + params for listing scenarios visible to the user.
 * Own scenarios are filtered to the active workspace; scenarios shared with
 * the user stay visible regardless of their active workspace (they live in
 * another user's workspace, which the viewer can never select). Applies to
 * admins too — row-level admin access via explicit id is unchanged.
 */
export function scenarioVisibilityClause(
  userId: string,
  role: Role,
  workspaceId: string,
  alias = "s",
): { sql: string; params: unknown[] } {
  return {
    sql: `((${alias}.creator_id = $1 AND ${alias}.workspace_id = $2) OR EXISTS (
      SELECT 1 FROM scenario_sharing ss
      WHERE ss.scenario_id = ${alias}.scenario_id AND ss.shared_with = $1
    ))`,
    params: [userId, workspaceId],
  };
}

export async function canReadDocument(
  userId: string,
  role: Role,
  documentId: string,
): Promise<boolean> {
  if (role === "admin") {
    const r = await pool.query("SELECT 1 FROM documents WHERE document_id = $1", [documentId]);
    return !!r.rows[0];
  }
  const r = await pool.query(
    `SELECT d.created_by, w.owner_id
     FROM documents d
     LEFT JOIN workspaces w ON w.workspace_id = d.workspace_id
     WHERE d.document_id = $1`,
    [documentId],
  );
  const row = r.rows[0];
  if (!row) return false;
  return row.created_by === userId || row.owner_id === userId;
}

export async function assertCanReadDocument(
  userId: string,
  role: Role,
  documentId: string,
): Promise<void> {
  const meta = await pool.query(
    `SELECT d.created_by, d.workspace_id, w.owner_id
     FROM documents d
     LEFT JOIN workspaces w ON w.workspace_id = d.workspace_id
     WHERE d.document_id = $1`,
    [documentId],
  );
  if (!meta.rows[0]) {
    throw Object.assign(new Error("Document not found"), { status: 404 });
  }
  const row = meta.rows[0];
  const ok = role === "admin" || row.created_by === userId || row.owner_id === userId;
  if (!ok) {
    throw Object.assign(new Error("Forbidden"), { status: 403 });
  }
  await assertOrgGateForWorkspace(userId, row.workspace_id);
}
