/**
 * Organizations — multi-tenant layer above workspaces.
 */

import { pool } from "../db/index.js";

export type OrgRole = "owner" | "admin" | "member";

export interface Organization {
  organization_id: string;
  name: string;
  slug: string | null;
  created_at: string;
  updated_at: string;
}

export interface OrganizationMember {
  membership_id: string;
  organization_id: string;
  user_id: string;
  org_role: OrgRole;
  email?: string;
  name?: string | null;
  created_at: string;
}

function httpError(message: string, status: number): Error {
  return Object.assign(new Error(message), { status });
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80) || "org"
  );
}

export async function assertOrgMember(userId: string, orgId: string): Promise<OrgRole> {
  const r = await pool.query(
    `SELECT org_role FROM organization_members
     WHERE organization_id = $1 AND user_id = $2`,
    [orgId, userId],
  );
  if (!r.rows[0]) {
    throw httpError("Not an organization member", 403);
  }
  return r.rows[0].org_role as OrgRole;
}

export async function assertOrgRole(
  userId: string,
  orgId: string,
  allowed: OrgRole[],
): Promise<OrgRole> {
  const role = await assertOrgMember(userId, orgId);
  if (!allowed.includes(role)) {
    throw httpError(`Requires org role: ${allowed.join("|")}`, 403);
  }
  return role;
}

export async function createOrganization(
  name: string,
  ownerUserId: string,
  slug?: string,
): Promise<Organization> {
  const trimmed = (name ?? "").trim();
  if (!trimmed) throw httpError("Organization name is required", 400);
  const orgSlug = (slug?.trim() || slugify(trimmed)).slice(0, 100);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const org = await client.query(
      `INSERT INTO organizations (name, slug) VALUES ($1, $2)
       RETURNING organization_id, name, slug, created_at, updated_at`,
      [trimmed, orgSlug],
    );
    await client.query(
      `INSERT INTO organization_members (organization_id, user_id, org_role)
       VALUES ($1, $2, 'owner')`,
      [org.rows[0].organization_id, ownerUserId],
    );
    await client.query("COMMIT");
    return org.rows[0];
  } catch (e) {
    await client.query("ROLLBACK");
    if ((e as { code?: string }).code === "23505") {
      throw httpError("Organization slug already exists", 409);
    }
    throw e;
  } finally {
    client.release();
  }
}

export async function listOrganizationsForUser(userId: string): Promise<
  Array<Organization & { org_role: OrgRole }>
> {
  const r = await pool.query(
    `SELECT o.organization_id, o.name, o.slug, o.created_at, o.updated_at, m.org_role
     FROM organizations o
     JOIN organization_members m ON m.organization_id = o.organization_id
     WHERE m.user_id = $1
     ORDER BY o.name ASC`,
    [userId],
  );
  return r.rows;
}

export async function getOrganization(orgId: string): Promise<Organization | null> {
  const r = await pool.query(
    `SELECT organization_id, name, slug, created_at, updated_at
     FROM organizations WHERE organization_id = $1`,
    [orgId],
  );
  return r.rows[0] ?? null;
}

export async function updateOrganization(
  orgId: string,
  patch: { name?: string; slug?: string },
): Promise<Organization> {
  const fields: string[] = [];
  const params: unknown[] = [orgId];
  if (patch.name != null) {
    const trimmed = patch.name.trim();
    if (!trimmed) throw httpError("Organization name is required", 400);
    params.push(trimmed);
    fields.push(`name = $${params.length}`);
  }
  if (patch.slug != null) {
    params.push(patch.slug.trim().slice(0, 100));
    fields.push(`slug = $${params.length}`);
  }
  if (fields.length === 0) throw httpError("No fields to update", 400);
  fields.push("updated_at = NOW()");
  try {
    const r = await pool.query(
      `UPDATE organizations SET ${fields.join(", ")}
       WHERE organization_id = $1
       RETURNING organization_id, name, slug, created_at, updated_at`,
      params,
    );
    if (!r.rows[0]) throw httpError("Organization not found", 404);
    return r.rows[0];
  } catch (e) {
    if ((e as { code?: string }).code === "23505") {
      throw httpError("Organization slug already exists", 409);
    }
    throw e;
  }
}

export async function deleteOrganization(orgId: string): Promise<void> {
  const r = await pool.query(`DELETE FROM organizations WHERE organization_id = $1`, [orgId]);
  if (r.rowCount === 0) throw httpError("Organization not found", 404);
}

export async function listMembers(orgId: string): Promise<OrganizationMember[]> {
  const r = await pool.query(
    `SELECT m.membership_id, m.organization_id, m.user_id, m.org_role, m.created_at,
            u.email, u.name
     FROM organization_members m
     JOIN users u ON u.user_id = m.user_id
     WHERE m.organization_id = $1
     ORDER BY m.created_at ASC`,
    [orgId],
  );
  return r.rows;
}

export async function addMember(
  orgId: string,
  userId: string,
  orgRole: OrgRole = "member",
): Promise<OrganizationMember> {
  if (!["owner", "admin", "member"].includes(orgRole)) {
    throw httpError("Invalid org_role", 400);
  }
  try {
    const r = await pool.query(
      `INSERT INTO organization_members (organization_id, user_id, org_role)
       VALUES ($1, $2, $3)
       RETURNING membership_id, organization_id, user_id, org_role, created_at`,
      [orgId, userId, orgRole],
    );
    return r.rows[0];
  } catch (e) {
    if ((e as { code?: string }).code === "23505") {
      throw httpError("User is already a member", 409);
    }
    if ((e as { code?: string }).code === "23503") {
      throw httpError("User or organization not found", 404);
    }
    throw e;
  }
}

export async function removeMember(orgId: string, userId: string): Promise<void> {
  const owners = await pool.query(
    `SELECT user_id FROM organization_members
     WHERE organization_id = $1 AND org_role = 'owner'`,
    [orgId],
  );
  if (owners.rows.length === 1 && owners.rows[0].user_id === userId) {
    throw httpError("Cannot remove the last owner", 400);
  }
  const r = await pool.query(
    `DELETE FROM organization_members WHERE organization_id = $1 AND user_id = $2`,
    [orgId, userId],
  );
  if (r.rowCount === 0) throw httpError("Member not found", 404);
}

export async function setMemberRole(
  orgId: string,
  userId: string,
  orgRole: OrgRole,
): Promise<OrganizationMember> {
  if (!["owner", "admin", "member"].includes(orgRole)) {
    throw httpError("Invalid org_role", 400);
  }
  if (orgRole !== "owner") {
    const owners = await pool.query(
      `SELECT user_id FROM organization_members
       WHERE organization_id = $1 AND org_role = 'owner'`,
      [orgId],
    );
    if (owners.rows.length === 1 && owners.rows[0].user_id === userId) {
      throw httpError("Cannot demote the last owner", 400);
    }
  }
  const r = await pool.query(
    `UPDATE organization_members SET org_role = $3
     WHERE organization_id = $1 AND user_id = $2
     RETURNING membership_id, organization_id, user_id, org_role, created_at`,
    [orgId, userId, orgRole],
  );
  if (!r.rows[0]) throw httpError("Member not found", 404);
  return r.rows[0];
}

export async function attachWorkspaceToOrg(
  workspaceId: string,
  organizationId: string | null,
  actorUserId: string,
  opts?: { allowAdmin?: boolean },
): Promise<{ workspace_id: string; organization_id: string | null }> {
  const ws = await pool.query(
    `SELECT workspace_id, owner_id, organization_id FROM workspaces
     WHERE workspace_id = $1 AND status = 'active'`,
    [workspaceId],
  );
  if (!ws.rows[0]) throw httpError("Workspace not found", 404);
  const isOwner = ws.rows[0].owner_id === actorUserId;
  if (!isOwner && !opts?.allowAdmin) {
    throw httpError("Only the workspace owner can attach an organization", 403);
  }
  if (organizationId && isOwner) {
    await assertOrgMember(actorUserId, organizationId);
  } else if (organizationId && opts?.allowAdmin) {
    // Platform admin may attach without membership; still verify org exists
    const org = await pool.query(
      `SELECT 1 FROM organizations WHERE organization_id = $1`,
      [organizationId],
    );
    if (!org.rows[0]) throw httpError("Organization not found", 404);
  }
  const r = await pool.query(
    `UPDATE workspaces SET organization_id = $2, updated_at = NOW()
     WHERE workspace_id = $1
     RETURNING workspace_id, organization_id`,
    [workspaceId, organizationId],
  );
  return r.rows[0];
}

/**
 * For each workspace owner without an org, create a personal org and attach
 * all of that owner's active workspaces that still have organization_id IS NULL.
 */
export async function backfillPersonalOrganizations(): Promise<{
  orgs_created: number;
  workspaces_attached: number;
}> {
  const owners = await pool.query(
    `SELECT DISTINCT w.owner_id, u.email, u.name
     FROM workspaces w
     JOIN users u ON u.user_id = w.owner_id
     WHERE w.status = 'active' AND w.organization_id IS NULL`,
  );
  let orgsCreated = 0;
  let workspacesAttached = 0;
  for (const owner of owners.rows) {
    const existing = await pool.query(
      `SELECT o.organization_id
       FROM organizations o
       JOIN organization_members m ON m.organization_id = o.organization_id
       WHERE m.user_id = $1 AND m.org_role = 'owner'
       ORDER BY o.created_at ASC LIMIT 1`,
      [owner.owner_id],
    );
    let orgId = existing.rows[0]?.organization_id as string | undefined;
    if (!orgId) {
      const label =
        (owner.name && String(owner.name).trim()) ||
        String(owner.email).split("@")[0] ||
        "Personal";
      const org = await createOrganization(`${label}'s Organization`, owner.owner_id);
      orgId = org.organization_id;
      orgsCreated += 1;
    }
    const updated = await pool.query(
      `UPDATE workspaces SET organization_id = $2, updated_at = NOW()
       WHERE owner_id = $1 AND status = 'active' AND organization_id IS NULL`,
      [owner.owner_id, orgId],
    );
    workspacesAttached += updated.rowCount ?? 0;
  }
  return { orgs_created: orgsCreated, workspaces_attached: workspacesAttached };
}

/** True when workspace has no org, or user is owner / org member. */
export async function userCanAccessWorkspaceOrg(
  userId: string,
  workspaceId: string,
): Promise<boolean> {
  const r = await pool.query(
    `SELECT owner_id, organization_id FROM workspaces
     WHERE workspace_id = $1 AND status = 'active'`,
    [workspaceId],
  );
  const row = r.rows[0];
  if (!row) return false;
  if (row.owner_id === userId) return true;
  if (!row.organization_id) return false;
  const m = await pool.query(
    `SELECT 1 FROM organization_members WHERE organization_id = $1 AND user_id = $2`,
    [row.organization_id, userId],
  );
  return !!m.rows[0];
}

/**
 * Additional org gate for document/scenario access.
 * Skips when workspace has no organization_id (workspace-only users unchanged).
 */
export async function assertOrgGateForWorkspace(
  userId: string,
  workspaceId: string | null | undefined,
): Promise<void> {
  if (!workspaceId) return;
  const r = await pool.query(
    `SELECT owner_id, organization_id FROM workspaces WHERE workspace_id = $1`,
    [workspaceId],
  );
  const row = r.rows[0];
  if (!row?.organization_id) return; // skip org check
  if (row.owner_id === userId) return;
  await assertOrgMember(userId, row.organization_id);
}
