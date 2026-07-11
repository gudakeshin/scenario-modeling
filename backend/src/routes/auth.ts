import { Router } from "express";
import { getAuthProvider } from "../auth/localProvider.js";
import { authenticate } from "../auth/middleware.js";
import { requireRole } from "../middleware/rbac.js";
import { validateBody } from "../middleware/validate.js";
import {
  loginSchema,
  logoutSchema,
  refreshSchema,
  registerSchema,
} from "../schemas/auth.js";
import { pool } from "../db/index.js";

export const authRouter = Router();

function clientMeta(req: { headers: Record<string, unknown>; ip?: string }) {
  return {
    userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : undefined,
    ip: req.ip,
  };
}

function sendError(res: import("express").Response, e: unknown) {
  const err = e as { status?: number; message?: string };
  const status = err.status ?? 500;
  return res.status(status).json({ error: err.message || "Auth error" });
}

/** Public bootstrap: first user with a password becomes admin. Later: admin-only. */
authRouter.post("/register", validateBody(registerSchema), async (req, res) => {
  try {
    const provider = getAuthProvider();
    const countRes = await pool.query(
      "SELECT COUNT(*)::int AS n FROM users WHERE password_hash IS NOT NULL"
    );
    const isFirst = countRes.rows[0].n === 0;

    if (!isFirst) {
      // Require admin Bearer for subsequent registrations
      const header = req.headers.authorization;
      if (!header?.startsWith("Bearer ")) {
        return res.status(403).json({
          error: "Registration is closed. An admin must create additional accounts.",
        });
      }
      const admin = await provider.verifyAccessToken(header.slice(7).trim());
      if (admin.role !== "admin") {
        return res.status(403).json({ error: "Only admins can register new users" });
      }
      const user = await provider.registerByAdmin(req.body, admin);
      return res.status(201).json({
        user_id: user.userId,
        email: user.email,
        name: user.name,
        role: user.role,
      });
    }

    const user = await provider.register(req.body);
    const { tokens } = await provider.login(
      { email: req.body.email, password: req.body.password },
      clientMeta(req)
    );
    return res.status(201).json({
      user: {
        user_id: user.userId,
        email: user.email,
        name: user.name,
        role: user.role,
      },
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      expires_in: tokens.expiresIn,
    });
  } catch (e) {
    return sendError(res, e);
  }
});

authRouter.post("/login", validateBody(loginSchema), async (req, res) => {
  try {
    const { user, tokens } = await getAuthProvider().login(req.body, clientMeta(req));
    return res.json({
      user: {
        user_id: user.userId,
        email: user.email,
        name: user.name,
        role: user.role,
      },
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      expires_in: tokens.expiresIn,
    });
  } catch (e) {
    return sendError(res, e);
  }
});

authRouter.post("/refresh", validateBody(refreshSchema), async (req, res) => {
  try {
    const tokens = await getAuthProvider().refresh(req.body.refresh_token, clientMeta(req));
    return res.json({
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      expires_in: tokens.expiresIn,
    });
  } catch (e) {
    return sendError(res, e);
  }
});

authRouter.post("/logout", validateBody(logoutSchema), async (req, res) => {
  try {
    await getAuthProvider().logout(req.body.refresh_token);
    return res.json({ ok: true });
  } catch (e) {
    return sendError(res, e);
  }
});

/** Who am I (authenticated). */
authRouter.get("/me", authenticate, async (req, res) => {
  const u = req.user!;
  return res.json({
    user_id: u.userId,
    email: u.email,
    name: u.name,
    role: u.role,
  });
});

/** Admin-only register alias (same as POST /register with admin token). */
authRouter.post(
  "/users",
  authenticate,
  requireRole("admin"),
  validateBody(registerSchema),
  async (req, res) => {
    try {
      const user = await getAuthProvider().registerByAdmin(req.body, req.user!);
      return res.status(201).json({
        user_id: user.userId,
        email: user.email,
        name: user.name,
        role: user.role,
      });
    } catch (e) {
      return sendError(res, e);
    }
  }
);
