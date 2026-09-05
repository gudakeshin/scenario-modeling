import type { Request, Response, NextFunction } from "express";
import { getAuthProvider } from "./getProvider.js";
import type { AuthUser, Role } from "./provider.js";

export type { AuthUser, Role };

declare global {
  // Express Request augmentation
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

/**
 * Require a valid Bearer access token. Mount on all /api/v1/* except /auth.
 */
export async function authenticate(req: Request, res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Authentication required" });
    }
    const token = header.slice(7).trim();
    if (!token) {
      return res.status(401).json({ error: "Authentication required" });
    }
    const user = await getAuthProvider().verifyAccessToken(token);
    req.user = user;
    next();
  } catch (e) {
    const status = (e as { status?: number }).status ?? 401;
    return res.status(status).json({ error: (e as Error).message || "Authentication failed" });
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.user) {
    return res.status(401).json({ error: "Authentication required" });
  }
  next();
}
