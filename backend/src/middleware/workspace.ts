import type { Request, Response, NextFunction } from "express";
import { pool } from "../db/index.js";
import { ensureDefaultWorkspace } from "../services/workspaceService.js";

/** Per-request scope: the authenticated user plus their selected workspace. */
export interface Scope {
  userId: string;
  workspaceId: string;
}

export interface RequestWorkspace {
  workspaceId: string;
  isDefault: boolean;
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

/**
 * Resolve the active workspace for the request from the X-Workspace-Id header.
 * Requires `authenticate` to have run first (req.user set).
 * - No header: fall back to the user's default workspace (lazy-created), so
 *   header-less clients behave exactly as before workspaces existed.
 * - Invalid UUID: 400. Workspace missing, deleted, or owned by someone else: 403.
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
    const raw = (req.headers["x-workspace-id"] as string | undefined)?.trim();
    if (raw && !isWorkspaceMgmt) {
      if (!UUID_RE.test(raw)) {
        return res.status(400).json({ error: "Invalid workspace id" });
      }
      const r = await pool.query(
        `SELECT workspace_id, is_default FROM workspaces
         WHERE workspace_id = $1 AND owner_id = $2 AND status = 'active'`,
        [raw, user.userId]
      );
      if (!r.rows[0]) {
        return res.status(403).json({ error: "Workspace not found", code: "WORKSPACE_NOT_FOUND" });
      }
      req.workspace = { workspaceId: r.rows[0].workspace_id, isDefault: r.rows[0].is_default };
      return next();
    }
    req.workspace = { workspaceId: await ensureDefaultWorkspace(user.userId), isDefault: true };
    return next();
  } catch (e) {
    return res.status(500).json({ error: (e as Error).message || "Failed to resolve workspace" });
  }
}
