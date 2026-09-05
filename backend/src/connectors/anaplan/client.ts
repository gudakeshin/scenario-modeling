import { logger } from "../../logger.js";
import type { ConnectorAuth } from "../types.js";
import { fetchWithTimeout } from "../http.js";

export type FetchLike = typeof fetch;

interface TokenCache {
  token: string;
  expiresAt: number;
}

export interface AnaplanClientOptions {
  auth: ConnectorAuth;
  fetchImpl?: FetchLike;
  maxRetries?: number;
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const DEFAULT_TOKEN_TTL_MS = 35 * 60_000;
const REFRESH_SKEW_MS = 5 * 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelay(response: Response, attempt: number): number {
  const raw = response.headers.get("retry-after");
  if (raw) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(raw);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  return Math.min(1000 * 2 ** attempt, 15_000);
}

function tokenFromResponse(body: unknown): TokenCache | null {
  if (!body || typeof body !== "object") return null;
  const value = body as {
    tokenInfo?: { tokenValue?: string; expiresAt?: number | string };
    access_token?: string;
    expires_in?: number;
  };
  const token = value.tokenInfo?.tokenValue ?? value.access_token;
  if (!token) return null;
  const explicitExpiry = Number(value.tokenInfo?.expiresAt);
  const expiresAt = Number.isFinite(explicitExpiry) && explicitExpiry > Date.now()
    ? explicitExpiry
    : Date.now() + (value.expires_in ? value.expires_in * 1000 : DEFAULT_TOKEN_TTL_MS);
  return { token, expiresAt };
}

export class AnaplanClient {
  private readonly auth: ConnectorAuth;
  private readonly fetchImpl: FetchLike;
  private readonly maxRetries: number;
  private tokenCache: TokenCache | null = null;
  private tokenInflight: Promise<string> | null = null;

  constructor(options: AnaplanClientOptions) {
    this.auth = options.auth;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxRetries = options.maxRetries ?? 4;
  }

  clearToken(): void {
    if (this.auth.kind !== "api_key") this.tokenCache = null;
  }

  private async authenticate(): Promise<TokenCache> {
    if (this.auth.kind === "api_key") {
      return { token: this.auth.apiKey, expiresAt: Number.POSITIVE_INFINITY };
    }
    const basic = Buffer.from(`${this.auth.clientId}:${this.auth.clientSecret}`).toString("base64");
    const tokenUrl = this.auth.tokenUrl || "https://auth.anaplan.com/token/authenticate";
    const response = await fetchWithTimeout(
      tokenUrl,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${basic}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
      },
      this.fetchImpl,
    );
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Anaplan token exchange failed (${response.status}): ${detail.slice(0, 200)}`);
    }
    const parsed = tokenFromResponse(await response.json());
    if (!parsed) throw new Error("Anaplan token response missing tokenValue");
    return parsed;
  }

  private async refresh(current: TokenCache): Promise<TokenCache> {
    const response = await fetchWithTimeout(
      "https://auth.anaplan.com/token/refresh",
      {
        method: "POST",
        headers: {
          Authorization: `AnaplanAuthToken ${current.token}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
      },
      this.fetchImpl,
    );
    if (!response.ok) {
      throw new Error(`Anaplan token refresh failed (${response.status})`);
    }
    const parsed = tokenFromResponse(await response.json());
    if (!parsed) throw new Error("Anaplan refresh response missing tokenValue");
    return parsed;
  }

  async getAccessToken(): Promise<string> {
    if (this.auth.kind === "api_key") return this.auth.apiKey;
    const now = Date.now();
    if (this.tokenCache && this.tokenCache.expiresAt - REFRESH_SKEW_MS > now) {
      return this.tokenCache.token;
    }
    if (this.tokenInflight) return this.tokenInflight;

    this.tokenInflight = (async () => {
      try {
        if (this.tokenCache) {
          try {
            this.tokenCache = await this.refresh(this.tokenCache);
            return this.tokenCache.token;
          } catch (error) {
            logger.warn({ err: error }, "Anaplan token refresh failed; authenticating again");
          }
        }
        this.tokenCache = await this.authenticate();
        return this.tokenCache.token;
      } finally {
        this.tokenInflight = null;
      }
    })();
    return this.tokenInflight;
  }

  async fetchRaw(url: string, init?: RequestInit, retry401 = true): Promise<Response> {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const token = await this.getAccessToken();
      const response = await fetchWithTimeout(
        url,
        {
          ...init,
          headers: {
            Accept: "application/json",
            Authorization: `AnaplanAuthToken ${token}`,
            ...(init?.headers || {}),
          },
        },
        this.fetchImpl,
      );
      if (response.ok) return response;

      if (response.status === 401 && retry401 && this.auth.kind !== "api_key") {
        this.clearToken();
        return this.fetchRaw(url, init, false);
      }
      if (RETRYABLE.has(response.status) && attempt < this.maxRetries) {
        const delay = retryDelay(response, attempt);
        logger.warn({ status: response.status, attempt, url, delay }, "Anaplan request retry");
        await sleep(delay);
        lastError = new Error(`Anaplan HTTP ${response.status}`);
        continue;
      }
      const detail = await response.text().catch(() => "");
      throw new Error(`Anaplan request failed (${response.status}): ${detail.slice(0, 300)}`);
    }
    throw lastError ?? new Error("Anaplan request failed");
  }

  async fetchJson(url: string, init?: RequestInit): Promise<unknown> {
    return await (await this.fetchRaw(url, init)).json();
  }

  async fetchText(url: string, init?: RequestInit): Promise<string> {
    return await (await this.fetchRaw(url, init)).text();
  }
}
