import { createHash, randomBytes, randomUUID } from "node:crypto";
import * as argon2 from "argon2";
import { SignJWT, jwtVerify } from "jose";
import { pool } from "../db/index.js";
import { config } from "../config.js";
import type {
  AuthProvider,
  AuthUser,
  LoginInput,
  RegisterInput,
  Role,
  TokenPair,
} from "./provider.js";

const secretKey = () => new TextEncoder().encode(config.JWT_SECRET);

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function toAuthUser(row: {
  user_id: string;
  email: string;
  name: string | null;
  role: string;
}): AuthUser {
  return {
    userId: row.user_id,
    email: row.email,
    name: row.name,
    role: row.role as Role,
  };
}

async function issueAccessToken(user: AuthUser): Promise<string> {
  const jti = randomUUID();
  return new SignJWT({
    email: user.email,
    role: user.role,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.userId)
    .setIssuer(config.JWT_ISSUER)
    .setAudience(config.JWT_AUDIENCE)
    .setJti(jti)
    .setIssuedAt()
    .setExpirationTime(`${config.ACCESS_TOKEN_TTL_SEC}s`)
    .sign(secretKey());
}

async function issueRefreshToken(
  userId: string,
  meta?: { userAgent?: string; ip?: string }
): Promise<string> {
  const raw = randomBytes(48).toString("base64url");
  const tokenHash = hashToken(raw);
  const expiresAt = new Date(Date.now() + config.REFRESH_TOKEN_TTL_SEC * 1000);
  await pool.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, user_agent, ip_address)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, tokenHash, expiresAt, meta?.userAgent ?? null, meta?.ip ?? null]
  );
  return raw;
}

async function issueTokenPair(
  user: AuthUser,
  meta?: { userAgent?: string; ip?: string }
): Promise<TokenPair> {
  const [accessToken, refreshToken] = await Promise.all([
    issueAccessToken(user),
    issueRefreshToken(user.userId, meta),
  ]);
  return {
    accessToken,
    refreshToken,
    expiresIn: config.ACCESS_TOKEN_TTL_SEC,
  };
}

export class LocalAuthProvider implements AuthProvider {
  readonly name = "local";

  async register(input: RegisterInput): Promise<AuthUser> {
    const email = input.email.trim().toLowerCase();
    if (!email || !input.password || input.password.length < 8) {
      throw Object.assign(new Error("Email and password (min 8 chars) required"), { status: 400 });
    }

    const countRes = await pool.query("SELECT COUNT(*)::int AS n FROM users WHERE password_hash IS NOT NULL");
    const isFirst = countRes.rows[0].n === 0;

    if (!isFirst) {
      // Subsequent registrations require an authenticated admin — enforced at route layer.
      // This method still creates the user when called by admin routes.
    }

    const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });
    const role: Role = isFirst ? "admin" : "analyst";

    try {
      const r = await pool.query(
        `INSERT INTO users (email, name, role, password_hash, is_active)
         VALUES ($1, $2, $3, $4, TRUE)
         RETURNING user_id, email, name, role`,
        [email, input.name?.trim() || null, role, passwordHash]
      );
      return toAuthUser(r.rows[0]);
    } catch (e) {
      const err = e as { code?: string };
      if (err.code === "23505") {
        throw Object.assign(new Error("Email already registered"), { status: 409 });
      }
      throw e;
    }
  }

  /** Admin-only registration of additional users (role selectable). */
  async registerByAdmin(
    input: RegisterInput & { role?: Role },
    _admin: AuthUser
  ): Promise<AuthUser> {
    const email = input.email.trim().toLowerCase();
    if (!email || !input.password || input.password.length < 8) {
      throw Object.assign(new Error("Email and password (min 8 chars) required"), { status: 400 });
    }
    const role = input.role ?? "analyst";
    if (!["viewer", "analyst", "approver", "admin"].includes(role)) {
      throw Object.assign(new Error("Invalid role"), { status: 400 });
    }
    const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });
    try {
      const r = await pool.query(
        `INSERT INTO users (email, name, role, password_hash, is_active)
         VALUES ($1, $2, $3, $4, TRUE)
         RETURNING user_id, email, name, role`,
        [email, input.name?.trim() || null, role, passwordHash]
      );
      return toAuthUser(r.rows[0]);
    } catch (e) {
      const err = e as { code?: string };
      if (err.code === "23505") {
        throw Object.assign(new Error("Email already registered"), { status: 409 });
      }
      throw e;
    }
  }

  async login(
    input: LoginInput,
    meta?: { userAgent?: string; ip?: string }
  ): Promise<{ user: AuthUser; tokens: TokenPair }> {
    const email = input.email.trim().toLowerCase();
    const r = await pool.query(
      `SELECT user_id, email, name, role, password_hash, is_active
       FROM users WHERE email = $1`,
      [email]
    );
    const row = r.rows[0];
    if (!row || !row.password_hash || !row.is_active) {
      throw Object.assign(new Error("Invalid email or password"), { status: 401 });
    }
    const ok = await argon2.verify(row.password_hash, input.password);
    if (!ok) {
      throw Object.assign(new Error("Invalid email or password"), { status: 401 });
    }
    const user = toAuthUser(row);
    const tokens = await issueTokenPair(user, meta);
    return { user, tokens };
  }

  async refresh(
    refreshToken: string,
    meta?: { userAgent?: string; ip?: string }
  ): Promise<TokenPair> {
    const tokenHash = hashToken(refreshToken);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const r = await client.query(
        `SELECT rt.token_id, rt.user_id, rt.expires_at, rt.revoked_at,
                u.email, u.name, u.role, u.is_active
         FROM refresh_tokens rt
         JOIN users u ON u.user_id = rt.user_id
         WHERE rt.token_hash = $1
         FOR UPDATE OF rt`,
        [tokenHash]
      );
      const row = r.rows[0];
      if (!row || row.revoked_at || new Date(row.expires_at) < new Date() || !row.is_active) {
        await client.query("ROLLBACK");
        throw Object.assign(new Error("Invalid or expired refresh token"), { status: 401 });
      }

      // Rotate: revoke old, issue new
      const newRaw = randomBytes(48).toString("base64url");
      const newHash = hashToken(newRaw);
      const expiresAt = new Date(Date.now() + config.REFRESH_TOKEN_TTL_SEC * 1000);
      const ins = await client.query(
        `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, user_agent, ip_address)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING token_id`,
        [row.user_id, newHash, expiresAt, meta?.userAgent ?? null, meta?.ip ?? null]
      );
      await client.query(
        `UPDATE refresh_tokens SET revoked_at = NOW(), replaced_by = $2 WHERE token_id = $1`,
        [row.token_id, ins.rows[0].token_id]
      );

      const user = toAuthUser({
        user_id: row.user_id,
        email: row.email,
        name: row.name,
        role: row.role,
      });
      const accessToken = await issueAccessToken(user);
      await client.query("COMMIT");
      return {
        accessToken,
        refreshToken: newRaw,
        expiresIn: config.ACCESS_TOKEN_TTL_SEC,
      };
    } catch (e) {
      try { await client.query("ROLLBACK"); } catch { /* ignore */ }
      throw e;
    } finally {
      client.release();
    }
  }

  async logout(refreshToken: string): Promise<void> {
    const tokenHash = hashToken(refreshToken);
    await pool.query(
      `UPDATE refresh_tokens SET revoked_at = NOW()
       WHERE token_hash = $1 AND revoked_at IS NULL`,
      [tokenHash]
    );
  }

  /** Issue local JWT pair for an already-authenticated user (OIDC callback). */
  async issueTokensForUser(
    user: AuthUser,
    meta?: { userAgent?: string; ip?: string },
  ): Promise<TokenPair> {
    return issueTokenPair(user, meta);
  }

  async verifyAccessToken(token: string): Promise<AuthUser> {
    try {
      const { payload } = await jwtVerify(token, secretKey(), {
        issuer: config.JWT_ISSUER,
        audience: config.JWT_AUDIENCE,
      });
      const userId = payload.sub;
      if (!userId || typeof payload.email !== "string" || typeof payload.role !== "string") {
        throw new Error("Invalid token claims");
      }
      const r = await pool.query(
        `SELECT user_id, email, name, role, is_active FROM users WHERE user_id = $1`,
        [userId]
      );
      const row = r.rows[0];
      if (!row || !row.is_active) {
        throw Object.assign(new Error("User inactive or not found"), { status: 401 });
      }
      return toAuthUser(row);
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 401) throw e;
      throw Object.assign(new Error("Invalid or expired access token"), { status: 401 });
    }
  }
}

