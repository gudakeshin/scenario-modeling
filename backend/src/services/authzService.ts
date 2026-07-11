import { pool } from "../db/index.js";
import type { Role } from "../auth/provider.js";

export type SharePermission = "view" | "edit";

async function getScenarioAccess(
  userId: string,
  role: Role,
  scenarioId: string
): Promise<{ exists: boolean; isOwner: boolean; permission: SharePermission | null }> {
  if (role === "admin") {
    const r = await pool.query(
      "SELECT creator_id FROM scenarios WHERE scenario_id = $1",
      [scenarioId]
    );
    if (!r.rows[0]) return { exists: false, isOwner: false, permission: null };
    return {
      exists: true,
      isOwner: r.rows[0].creator_id === userId,
      permission: "edit",
    };
  }

  const r = await pool.query(
    `SELECT s.creator_id, ss.permission
     FROM scenarios s
     LEFT JOIN scenario_sharing ss
       ON ss.scenario_id = s.scenario_id AND ss.shared_with = $2
     WHERE s.scenario_id = $1`,
    [scenarioId, userId]
  );
  const row = r.rows[0];
  if (!row) return { exists: false, isOwner: false, permission: null };
  const isOwner = row.creator_id === userId;
  const permission: SharePermission | null = isOwner
    ? "edit"
    : (row.permission as SharePermission | null);
  return { exists: true, isOwner, permission };
}

export async function canReadScenario(
  userId: string,
  role: Role,
  scenarioId: string
): Promise<boolean> {
  const access = await getScenarioAccess(userId, role, scenarioId);
  return access.exists && (access.isOwner || access.permission !== null || role === "admin");
}

export async function canWriteScenario(
  userId: string,
  role: Role,
  scenarioId: string
): Promise<boolean> {
  const access = await getScenarioAccess(userId, role, scenarioId);
  if (!access.exists) return false;
  if (role === "admin" || access.isOwner) return true;
  return access.permission === "edit";
}

export async function assertCanReadScenario(
  userId: string,
  role: Role,
  scenarioId: string
): Promise<void> {
  const ok = await canReadScenario(userId, role, scenarioId);
  if (!ok) {
    const exists = (
      await pool.query("SELECT 1 FROM scenarios WHERE scenario_id = $1", [scenarioId])
    ).rows[0];
    if (!exists) {
      throw Object.assign(new Error("Scenario not found"), { status: 404 });
    }
    throw Object.assign(new Error("Forbidden"), { status: 403 });
  }
}

export async function assertCanWriteScenario(
  userId: string,
  role: Role,
  scenarioId: string
): Promise<void> {
  const ok = await canWriteScenario(userId, role, scenarioId);
  if (!ok) {
    const exists = (
      await pool.query("SELECT 1 FROM scenarios WHERE scenario_id = $1", [scenarioId])
    ).rows[0];
    if (!exists) {
      throw Object.assign(new Error("Scenario not found"), { status: 404 });
    }
    throw Object.assign(new Error("Forbidden"), { status: 403 });
  }
}

/** SQL fragment + params for listing scenarios visible to the user. */
export function scenarioVisibilityClause(
  userId: string,
  role: Role,
  alias = "s"
): { sql: string; params: unknown[] } {
  if (role === "admin") {
    return { sql: "TRUE", params: [] };
  }
  return {
    sql: `(${alias}.creator_id = $1 OR EXISTS (
      SELECT 1 FROM scenario_sharing ss
      WHERE ss.scenario_id = ${alias}.scenario_id AND ss.shared_with = $1
    ))`,
    params: [userId],
  };
}

export async function canReadDocument(
  userId: string,
  role: Role,
  documentId: string
): Promise<boolean> {
  if (role === "admin") {
    const r = await pool.query("SELECT 1 FROM documents WHERE document_id = $1", [documentId]);
    return !!r.rows[0];
  }
  const r = await pool.query(
    "SELECT 1 FROM documents WHERE document_id = $1 AND created_by = $2",
    [documentId, userId]
  );
  return !!r.rows[0];
}

export async function assertCanReadDocument(
  userId: string,
  role: Role,
  documentId: string
): Promise<void> {
  const ok = await canReadDocument(userId, role, documentId);
  if (!ok) {
    const exists = (
      await pool.query("SELECT 1 FROM documents WHERE document_id = $1", [documentId])
    ).rows[0];
    if (!exists) {
      throw Object.assign(new Error("Document not found"), { status: 404 });
    }
    throw Object.assign(new Error("Forbidden"), { status: 403 });
  }
}
