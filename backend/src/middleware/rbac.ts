import type { Request, Response, NextFunction } from "express";
import { pool, getDefaultUserId } from "../db/index.js";

export type Role = "viewer" | "analyst" | "approver" | "admin";

const ROLE_HIERARCHY: Record<Role, number> = {
  viewer: 0,
  analyst: 1,
  approver: 2,
  admin: 3,
};

/**
 * Middleware that checks the user has at least `minRole`.
 * In V1, user is identified via `x-user-id` header or falls back to the default user.
 * In production, this would be replaced by SSO/JWT.
 */
export function requireRole(minRole: Role) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.headers["x-user-id"] as string | undefined;
      let role: Role = "viewer";
      if (userId) {
        // Support both UUID and email as user identifier
        const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId);
        const r = isUuid
          ? await pool.query("SELECT role FROM users WHERE user_id = $1", [userId])
          : await pool.query("SELECT role FROM users WHERE email = $1", [userId]);
        if (r.rows[0]) role = r.rows[0].role as Role;
        else return res.status(403).json({ error: "User not found" });
      } else {
        // Fallback: get default system user role via DB function
        const defaultId = await getDefaultUserId();
        const r = await pool.query("SELECT role FROM users WHERE user_id = $1", [defaultId]);
        role = (r.rows[0]?.role as Role) || "analyst";
      }

      if (ROLE_HIERARCHY[role] < ROLE_HIERARCHY[minRole]) {
        return res.status(403).json({ error: `Requires role '${minRole}' or above. Your role: '${role}'` });
      }
      (req as unknown as Record<string, unknown>).userRole = role;
      next();
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: "Authorization failed" });
    }
  };
}
