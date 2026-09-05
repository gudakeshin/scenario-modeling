/**
 * OIDC / OAuth2 auth provider behind the AuthProvider seam.
 * Local auth remains default; set AUTH_PROVIDER=oidc with OIDC_* env vars.
 *
 * Authorization-code callback upserts a local user shadow and issues the same
 * local JWT pair as password login. verifyAccessToken still accepts IdP JWTs
 * when clients present them directly.
 */

import { createRemoteJWKSet, jwtVerify } from "jose";
import { randomBytes } from "node:crypto";
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
import { LocalAuthProvider } from "./localProvider.js";

function mapRole(claim: unknown): Role {
  const raw = String(claim || "viewer").toLowerCase();
  if (raw === "admin" || raw === "approver" || raw === "analyst" || raw === "viewer") {
    return raw;
  }
  if (raw.includes("admin")) return "admin";
  if (raw.includes("approver")) return "approver";
  if (raw.includes("analyst") || raw.includes("finance")) return "analyst";
  return "viewer";
}

function issuerBase(): string {
  if (!config.OIDC_ISSUER) throw new Error("OIDC_ISSUER is required");
  return config.OIDC_ISSUER.replace(/\/$/, "");
}

export function isOidcConfigured(): boolean {
  return Boolean(config.OIDC_ISSUER && config.OIDC_CLIENT_ID);
}

export class OidcAuthProvider implements AuthProvider {
  readonly name = "oidc";
  private jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
  private localFallback = new LocalAuthProvider();

  private getJwks() {
    if (!config.OIDC_ISSUER) {
      throw new Error("OIDC_ISSUER is required when AUTH_PROVIDER=oidc");
    }
    if (!this.jwks) {
      const url = new URL(`${issuerBase()}/.well-known/jwks.json`);
      this.jwks = createRemoteJWKSet(url);
    }
    return this.jwks;
  }

  async register(_input: RegisterInput): Promise<AuthUser> {
    throw new Error("Registration is managed by the identity provider (OIDC)");
  }

  async login(_input: LoginInput): Promise<{ user: AuthUser; tokens: TokenPair }> {
    throw new Error(
      "Password login is disabled for OIDC. Use the IdP authorization code flow and exchange for tokens.",
    );
  }

  async refresh(_refreshToken: string): Promise<TokenPair> {
    throw new Error("Use the identity provider token endpoint to refresh OIDC tokens");
  }

  async logout(_refreshToken: string): Promise<void> {
    // IdP logout is client-driven (end_session_endpoint)
  }

  /** Build the IdP authorize URL (authorization code + state carrying optional next path). */
  buildAuthorizeUrl(opts?: { state?: string; redirectUri?: string; next?: string }): {
    authorize_url: string;
    state: string;
  } {
    if (!isOidcConfigured()) {
      throw Object.assign(new Error("OIDC is not configured"), { status: 503 });
    }
    const nonce = randomBytes(12).toString("hex");
    const next = opts?.next && opts.next.startsWith("/") ? opts.next : "/";
    const state =
      opts?.state ||
      Buffer.from(JSON.stringify({ n: next, r: nonce }), "utf8").toString("base64url");
    const redirectUri =
      opts?.redirectUri ||
      config.OIDC_REDIRECT_URI ||
      `http://localhost:${config.PORT}/api/v1/auth/oidc/callback`;
    const authEndpoint =
      config.OIDC_AUTHORIZATION_ENDPOINT || `${issuerBase()}/authorize`;
    const params = new URLSearchParams({
      client_id: config.OIDC_CLIENT_ID!,
      response_type: "code",
      scope: "openid profile email",
      redirect_uri: redirectUri,
      state,
    });
    if (config.OIDC_AUDIENCE) params.set("audience", config.OIDC_AUDIENCE);
    return { authorize_url: `${authEndpoint}?${params.toString()}`, state };
  }

  static parseStateNext(state: string | undefined): string | null {
    if (!state) return null;
    try {
      const json = JSON.parse(Buffer.from(state, "base64url").toString("utf8")) as {
        n?: string;
      };
      return json.n && json.n.startsWith("/") ? json.n : null;
    } catch {
      return null;
    }
  }

  /**
   * Exchange authorization code for IdP tokens, upsert local user, issue local JWT.
   */
  async handleCallback(
    code: string,
    meta?: { userAgent?: string; ip?: string; redirectUri?: string },
  ): Promise<{ user: AuthUser; tokens: TokenPair }> {
    if (!isOidcConfigured() || !config.OIDC_CLIENT_SECRET) {
      throw Object.assign(new Error("OIDC is not fully configured"), { status: 503 });
    }
    const redirectUri =
      meta?.redirectUri ||
      config.OIDC_REDIRECT_URI ||
      `http://localhost:${config.PORT}/api/v1/auth/oidc/callback`;
    const tokenEndpoint = config.OIDC_TOKEN_ENDPOINT || `${issuerBase()}/oauth/token`;

    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: config.OIDC_CLIENT_ID!,
      client_secret: config.OIDC_CLIENT_SECRET,
    });
    const tokenRes = await fetch(tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body,
    });
    if (!tokenRes.ok) {
      throw Object.assign(new Error(`OIDC token exchange failed (${tokenRes.status})`), {
        status: 502,
      });
    }
    const tokenBody = (await tokenRes.json()) as {
      access_token?: string;
      id_token?: string;
    };
    const idOrAccess = tokenBody.id_token || tokenBody.access_token;
    if (!idOrAccess) {
      throw Object.assign(new Error("OIDC token response missing id_token/access_token"), {
        status: 502,
      });
    }

    // Prefer JWKS verify when possible; fall back to decoding claims from payload segment
    let email = "";
    let name: string | null = null;
    let role: Role = "analyst";
    try {
      const { payload } = await jwtVerify(idOrAccess, this.getJwks(), {
        issuer: config.OIDC_ISSUER,
        audience: config.OIDC_AUDIENCE || config.OIDC_CLIENT_ID,
      });
      email = String(payload.email || payload.preferred_username || "").toLowerCase();
      name = payload.name ? String(payload.name) : null;
      role = mapRole(payload.role || payload["https://scenario-modeling/role"]);
    } catch {
      const parts = idOrAccess.split(".");
      if (parts.length >= 2) {
        const json = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<
          string,
          unknown
        >;
        email = String(json.email || json.preferred_username || "").toLowerCase();
        name = json.name ? String(json.name) : null;
        role = mapRole(json.role || json["https://scenario-modeling/role"]);
      }
    }
    if (!email) {
      throw Object.assign(new Error("OIDC token missing email claim"), { status: 400 });
    }

    const user = await this.upsertUser(email, name, role);
    const tokens = await this.localFallback.issueTokensForUser(user, meta);
    return { user, tokens };
  }

  private async upsertUser(email: string, name: string | null, role: Role): Promise<AuthUser> {
    const existing = await pool.query(
      `SELECT user_id, email, name, role FROM users WHERE email = $1`,
      [email],
    );
    if (existing.rows.length > 0) {
      return {
        userId: existing.rows[0].user_id,
        email: existing.rows[0].email,
        name: existing.rows[0].name,
        role: (existing.rows[0].role as Role) || role,
      };
    }
    const inserted = await pool.query(
      `INSERT INTO users (email, name, role) VALUES ($1, $2, $3)
       RETURNING user_id, email, name, role`,
      [email, name, role],
    );
    return {
      userId: inserted.rows[0].user_id,
      email: inserted.rows[0].email,
      name: inserted.rows[0].name,
      role: inserted.rows[0].role as Role,
    };
  }

  async verifyAccessToken(token: string): Promise<AuthUser> {
    // Prefer local JWT (issued at callback); fall back to IdP JWKS
    try {
      return await this.localFallback.verifyAccessToken(token);
    } catch {
      /* try IdP */
    }

    const { payload } = await jwtVerify(token, this.getJwks(), {
      issuer: config.OIDC_ISSUER,
      audience: config.OIDC_AUDIENCE || config.OIDC_CLIENT_ID,
    });

    const email = String(payload.email || payload.preferred_username || "").toLowerCase();
    if (!email) throw new Error("OIDC token missing email claim");
    const name = payload.name ? String(payload.name) : null;
    const role = mapRole(payload.role || payload["https://scenario-modeling/role"]);
    return this.upsertUser(email, name, role);
  }

  /** Dev escape hatch — local login still available for break-glass when configured. */
  getLocalFallback(): LocalAuthProvider {
    return this.localFallback;
  }
}
