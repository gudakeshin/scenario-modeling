import { Router } from "express";
import { getAuthProvider, getLocalAuthProvider } from "../auth/getProvider.js";
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
import { config } from "../config.js";
import { isOidcConfigured, OidcAuthProvider } from "../auth/oidcProvider.js";
import { setAuthCookies, clearAuthCookies, readRefreshToken } from "../auth/cookies.js";

export const authRouter = Router();

function clientMeta(req: { headers: Record<string, unknown>; ip?: string }) {
  return {
    userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : undefined,
    ip: req.ip,
  };
}

function tokenResponse(
  res: import("express").Response,
  user: { userId: string; email: string; name: string | null; role: string },
  tokens: { accessToken: string; refreshToken: string; expiresIn: number },
  status = 200,
) {
  setAuthCookies(res, tokens.refreshToken);
  const body: Record<string, unknown> = {
    user: {
      user_id: user.userId,
      email: user.email,
      name: user.name,
      role: user.role,
    },
    access_token: tokens.accessToken,
    expires_in: tokens.expiresIn,
  };
  if (config.AUTH_REFRESH_BODY_FALLBACK) {
    body.refresh_token = tokens.refreshToken;
  }
  return res.status(status).json(body);
}

function sendError(res: import("express").Response, e: unknown) {
  const err = e as { status?: number; message?: string };
  const status = err.status ?? 500;
  return res.status(status).json({ error: err.message || "Auth error" });
}

/** Public bootstrap: first user with a password becomes admin. Later: admin-only. */
authRouter.post("/register", validateBody(registerSchema), async (req, res) => {
  try {
    if (config.AUTH_PROVIDER === "oidc") {
      return res.status(400).json({
        error: "Local registration is disabled when AUTH_PROVIDER=oidc",
      });
    }
    const provider = getLocalAuthProvider();
    const countRes = await pool.query(
      "SELECT COUNT(*)::int AS n FROM users WHERE password_hash IS NOT NULL",
    );
    const isFirst = countRes.rows[0].n === 0;

    if (!isFirst) {
      const header = req.headers.authorization;
      if (!header?.startsWith("Bearer ")) {
        return res.status(403).json({
          error: "Registration is closed. An admin must create additional accounts.",
        });
      }
      const admin = await getAuthProvider().verifyAccessToken(header.slice(7).trim());
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
      clientMeta(req),
    );
    return tokenResponse(
      res,
      { userId: user.userId, email: user.email, name: user.name, role: user.role },
      tokens,
      201,
    );
  } catch (e) {
    return sendError(res, e);
  }
});

authRouter.post("/login", validateBody(loginSchema), async (req, res) => {
  try {
    if (config.AUTH_PROVIDER === "oidc") {
      return res.status(400).json({
        error: "Password login is disabled when AUTH_PROVIDER=oidc. Use the identity provider.",
      });
    }
    const { user, tokens } = await getLocalAuthProvider().login(req.body, clientMeta(req));
    return tokenResponse(
      res,
      { userId: user.userId, email: user.email, name: user.name, role: user.role },
      tokens,
    );
  } catch (e) {
    return sendError(res, e);
  }
});

authRouter.post("/refresh", validateBody(refreshSchema), async (req, res) => {
  try {
    if (config.AUTH_PROVIDER === "oidc") {
      return res.status(400).json({
        error: "Refresh via IdP token endpoint when AUTH_PROVIDER=oidc",
      });
    }
    const refreshToken = readRefreshToken(req, req.body.refresh_token);
    if (!refreshToken) {
      return res.status(401).json({ error: "Refresh token required" });
    }
    const tokens = await getLocalAuthProvider().refresh(refreshToken, clientMeta(req));
    setAuthCookies(res, tokens.refreshToken);
    const body: Record<string, unknown> = {
      access_token: tokens.accessToken,
      expires_in: tokens.expiresIn,
    };
    if (config.AUTH_REFRESH_BODY_FALLBACK) {
      body.refresh_token = tokens.refreshToken;
    }
    return res.json(body);
  } catch (e) {
    return sendError(res, e);
  }
});

authRouter.post("/logout", validateBody(logoutSchema), async (req, res) => {
  try {
    const refreshToken = readRefreshToken(req, req.body.refresh_token);
    if (refreshToken) {
      await getAuthProvider().logout(refreshToken);
    }
    clearAuthCookies(res);
    return res.json({ ok: true });
  } catch (e) {
    return sendError(res, e);
  }
});

/** Public auth bootstrap for the login UI. */
authRouter.get("/config", (_req, res) => {
  return res.json({
    auth_provider: config.AUTH_PROVIDER,
    oidc_enabled: isOidcConfigured(),
  });
});

/** OIDC: redirect browser to IdP authorize URL. */
authRouter.get("/oidc/authorize", (req, res) => {
  try {
    if (!isOidcConfigured()) {
      return res.status(503).json({ error: "OIDC is not configured" });
    }
    const provider =
      getAuthProvider() instanceof OidcAuthProvider
        ? (getAuthProvider() as OidcAuthProvider)
        : new OidcAuthProvider();
    const next =
      typeof req.query.next === "string" && req.query.next.startsWith("/")
        ? req.query.next
        : "/";
    const { authorize_url, state } = provider.buildAuthorizeUrl({ next });
    if (req.query.redirect === "0" || req.query.format === "json") {
      return res.json({ authorize_url, state });
    }
    return res.redirect(302, authorize_url);
  } catch (e) {
    return sendError(res, e);
  }
});

/**
 * OIDC callback: exchange code → upsert user → issue local JWT
 * (same response shape as password login). Sets the refresh token as an
 * httpOnly cookie and redirects to the frontend with no tokens in the URL.
 */
authRouter.get("/oidc/callback", async (req, res) => {
  try {
    const code = typeof req.query.code === "string" ? req.query.code : "";
    if (!code) {
      return res.status(400).json({ error: "Missing authorization code" });
    }
    const provider =
      getAuthProvider() instanceof OidcAuthProvider
        ? (getAuthProvider() as OidcAuthProvider)
        : new OidcAuthProvider();
    const { user, tokens } = await provider.handleCallback(code, clientMeta(req));
    const fromState = OidcAuthProvider.parseStateNext(
      typeof req.query.state === "string" ? req.query.state : undefined,
    );
    const next =
      (typeof req.query.next === "string" && req.query.next.startsWith("/")
        ? req.query.next
        : null) ||
      fromState ||
      "/";
    if (req.query.format === "json") {
      return tokenResponse(
        res,
        { userId: user.userId, email: user.email, name: user.name, role: user.role },
        tokens,
      );
    }
    setAuthCookies(res, tokens.refreshToken);
    const dest = new URL(next, config.FRONTEND_ORIGIN);
    dest.searchParams.set("oidc", "1");
    return res.redirect(302, dest.toString());
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
    auth_provider: config.AUTH_PROVIDER,
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
      const user = await getLocalAuthProvider().registerByAdmin(req.body, req.user!);
      return res.status(201).json({
        user_id: user.userId,
        email: user.email,
        name: user.name,
        role: user.role,
      });
    } catch (e) {
      return sendError(res, e);
    }
  },
);
