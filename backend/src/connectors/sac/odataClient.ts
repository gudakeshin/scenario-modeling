/**
 * OAuth2 + OData HTTP client with retry, 401 refresh, and nextLink paging.
 */

import { logger } from "../../logger.js";
import type { ConnectorAuth } from "../types.js";

export type FetchLike = typeof fetch;

export interface ODataClientOptions {
  auth: ConnectorAuth;
  fetchImpl?: FetchLike;
  maxRetries?: number;
  defaultPageSize?: number;
  maxPages?: number;
}

interface TokenCache {
  accessToken: string;
  expiresAt: number;
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class ODataClient {
  private auth: ConnectorAuth;
  private fetchImpl: FetchLike;
  private maxRetries: number;
  private tokenCache: TokenCache | null = null;
  private tokenInflight: Promise<string> | null = null;
  readonly defaultPageSize: number;
  readonly maxPages: number;

  constructor(opts: ODataClientOptions) {
    this.auth = opts.auth;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.maxRetries = opts.maxRetries ?? 4;
    this.defaultPageSize = opts.defaultPageSize ?? 1000;
    this.maxPages = opts.maxPages ?? 10_000;
  }

  clearToken(): void {
    this.tokenCache = null;
  }

  async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.tokenCache && this.tokenCache.expiresAt - 60_000 > now) {
      return this.tokenCache.accessToken;
    }
    if (this.tokenInflight) return this.tokenInflight;

    this.tokenInflight = (async () => {
      try {
        if (this.auth.kind === "api_key") {
          this.tokenCache = {
            accessToken: this.auth.apiKey,
            expiresAt: Date.now() + 3600_000,
          };
          return this.auth.apiKey;
        }
        const body = new URLSearchParams({
          grant_type: "client_credentials",
          client_id: this.auth.clientId,
          client_secret: this.auth.clientSecret,
        });
        const res = await this.fetchImpl(this.auth.tokenUrl, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body,
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`SAC token fetch failed (${res.status}): ${text.slice(0, 200)}`);
        }
        const json = (await res.json()) as { access_token: string; expires_in?: number };
        const expiresIn = (json.expires_in ?? 3600) * 1000;
        this.tokenCache = {
          accessToken: json.access_token,
          expiresAt: Date.now() + expiresIn,
        };
        return json.access_token;
      } finally {
        this.tokenInflight = null;
      }
    })();

    return this.tokenInflight;
  }

  async fetchRaw(url: string, init?: RequestInit, allowRetry401 = true): Promise<Response> {
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const token = await this.getAccessToken();
      const res = await this.fetchImpl(url, {
        ...init,
        headers: {
          Accept: "application/json, application/xml, text/xml, */*",
          Authorization:
            this.auth.kind === "api_key" ? `Bearer ${token}` : `Bearer ${token}`,
          ...(init?.headers || {}),
        },
      });

      if (res.ok) return res;

      if (res.status === 401 && allowRetry401) {
        this.clearToken();
        return this.fetchRaw(url, init, false);
      }

      if (RETRYABLE.has(res.status) && attempt < this.maxRetries) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const backoff = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : Math.min(1000 * 2 ** attempt, 15_000);
        logger.warn({ status: res.status, attempt, url }, "SAC request retry");
        await sleep(backoff);
        lastErr = new Error(`SAC HTTP ${res.status}`);
        continue;
      }

      const text = await res.text().catch(() => "");
      throw new Error(`SAC request failed (${res.status}): ${text.slice(0, 300)}`);
    }
    throw lastErr ?? new Error("SAC request failed");
  }

  async fetchJson(url: string, init?: RequestInit): Promise<unknown> {
    const res = await this.fetchRaw(url, init);
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("xml")) {
      return await res.text();
    }
    if (ct.includes("text/plain")) {
      const text = await res.text();
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return text;
      }
    }
    return await res.json();
  }

  async fetchText(url: string, init?: RequestInit): Promise<string> {
    const res = await this.fetchRaw(url, {
      ...init,
      headers: { Accept: "application/xml, text/xml, */*", ...(init?.headers || {}) },
    });
    return await res.text();
  }

  async *paginateJson(
    startUrl: string,
    opts?: { maxPages?: number },
  ): AsyncGenerator<{ value: unknown[]; nextLink?: string; page: number }> {
    const maxPages = opts?.maxPages ?? this.maxPages;
    let nextUrl: string | null = startUrl;
    let page = 0;
    while (nextUrl) {
      page += 1;
      if (page > maxPages) {
        throw new Error(`SAC pagination exceeded SAC_MAX_FACT_PAGES (${maxPages})`);
      }
      const currentUrl: string = nextUrl;
      const data = (await this.fetchJson(currentUrl)) as {
        value?: unknown[];
        "@odata.nextLink"?: string;
      };
      const value = data.value ?? [];
      const nextLink = data["@odata.nextLink"];
      if (value.length > 0 && !nextLink && value.length >= this.defaultPageSize) {
        logger.warn(
          { url: currentUrl, pageSize: value.length },
          "SAC page may be truncated (no nextLink)",
        );
      }
      yield { value, nextLink, page };
      nextUrl = nextLink ? new URL(nextLink, currentUrl).toString() : null;
    }
  }
}
