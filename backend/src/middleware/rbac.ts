import type { Request, Response, NextFunction } from "express";
import type { Role } from "../auth/provider.js";

const ROLE_HIERARCHY: Record<Role, number> = {
  viewer: 0,
  analyst: 1,
  approver: 2,
  admin: 3,
};

/**
 * Middleware that checks the authenticated user has at least `minRole`.
 * Requires `authenticate` to have run first (req.user set).
 */
export function requireRole(minRole: Role) {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: "Authentication required" });
    }
    if (ROLE_HIERARCHY[user.role] < ROLE_HIERARCHY[minRole]) {
      return res.status(403).json({
        error: `Requires role '${minRole}' or above. Your role: '${user.role}'`,
      });
    }
    next();
  };
}

export type { Role };
