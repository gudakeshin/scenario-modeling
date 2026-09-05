import type { Request, Response, NextFunction } from "express";
import { pool } from "../db/index.js";
import { ensureDefaultWorkspace } from "../services/workspaceService.js";
import { assertUpsIWorkspaceMembership } from "../services/upsiGovernanceService.js";

/** Per-request scope: the authenticated user plus their selected workspace. */
export interface Scope {
  userId: string;
  workspaceId: string;
}

export interface RequestWorkspace {
  workspaceId: string;
  isDefault: boolean;
  sensitivity?: "public" | "confidential" | "upsi";
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      workspace?: RequestWorkspace;
    }
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Build a Scope from an authenticated, workspace-resolved request. */
export function scopeOf(req: Request): Scope {
  return { userId: req.user!.userId, workspaceId: req.workspace!.workspaceId };
}

async function authorizeWorkspaceAccess(
  userId: string,
  role: string,
  workspaceId: string,
): Promise<{
  workspaceId: string;
  isDefault: boolean;
  sensitivity: "public" | "confidential" | "upsi";
} | null> {
  const r = await pool.query(
    `SELECT workspace_id, is_default, owner_id, organization_id, sensitivity
     FROM workspaces
     WHERE workspace_id = $1 AND status = 'active'`,
    [workspaceId],
  );
  if (!r.rows[0]) return null;
  const ws = r.rows[0];
  let allowed = ws.owner_id === userId || role === "admin";
  if (ws.sensitivity === "upsi") {
    // No admin/role fallthrough for UPSI — explicit membership only.
    const membership = await pool.query(
      `SELECT 1 FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2`,
      [ws.workspace_id, userId],
    );
    allowed = !!membership.rows[0];
  } else if (!allowed && ws.organization_id) {
    const mem = await pool.query(
      `SELECT 1 FROM organization_members WHERE organization_id = $1 AND user_id = $2`,
      [ws.organization_id, userId],
    );
    allowed = !!mem.rows[0];
  }
  if (!allowed) return null;
  await assertUpsIWorkspaceMembership(userId, ws.workspace_id);
  return {
    workspaceId: ws.workspace_id,
    isDefault: ws.is_default,
    sensitivity: ws.sensitivity,
  };
}

/**
 * Resolve the active workspace for the request from the X-Workspace-Id header.
 * Requires `authenticate` to have run first (req.user set).
 * - No header: fall back to the user's default workspace (lazy-created), so
 *   header-less clients behave exactly as before workspaces existed.
 * - Invalid UUID: 400.
 * - Workspace missing/deleted: 403.
 * - Access: owner, OR org member when workspace.organization_id is set.
 *   UPSI workspaces additionally require explicit workspace membership.
 */
export async function resolveWorkspace(req: Request, res: Response, next: NextFunction) {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: "Authentication required" });
    }
    // Workspace management routes must stay reachable even with a stale
    // header (e.g. the active workspace was deleted in another tab), so a
    // client can always list workspaces and recover.
    const isWorkspaceMgmt = req.path === "/workspaces" || req.path.startsWith("/workspaces/");
    const isOrgMgmt =
      req.path === "/organizations" || req.path.startsWith("/organizations/");
    const raw = (req.headers["x-workspace-id"] as string | undefined)?.trim();

    if (isWorkspaceMgmt || isOrgMgmt) {
      req.workspace = {
        workspaceId: await ensureDefaultWorkspace(user.userId),
        isDefault: true,
      };
      return next();
    }

    const workspaceId = raw
      ? raw
      : await ensureDefaultWorkspace(user.userId);

    if (raw && !UUID_RE.test(raw)) {
      return res.status(400).json({ error: "Invalid workspace id" });
    }

    const authorized = await authorizeWorkspaceAccess(user.userId, user.role, workspaceId);
    if (!authorized) {
      return res.status(403).json({ error: "Workspace not found", code: "WORKSPACE_NOT_FOUND" });
    }

    req.workspace = {
      workspaceId: authorized.workspaceId,
      isDefault: authorized.isDefault,
      sensitivity: authorized.sensitivity,
    };
    return next();
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (status) {
      return res.status(status).json({
        error: (e as Error).message || "Failed to resolve workspace",
        code: (e as { code?: string }).code,
      });
    }
    return res.status(500).json({ error: (e as Error).message || "Failed to resolve workspace" });
  }
}
