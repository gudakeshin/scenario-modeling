/**
 * Shared connector HTTP helper — timeout + per-request SSRF guard.
 */

import { assertSafeEgress } from "./egressGuard.js";

const DEFAULT_TIMEOUT_MS = 30_000;

export function connectorHttpTimeoutMs(): number {
  const raw = process.env.CONNECTOR_HTTP_TIMEOUT_MS;
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_TIMEOUT_MS;
}

export type FetchLike = typeof fetch;

export interface FetchWithTimeoutInit extends RequestInit {
  timeoutMs?: number;
  /** Skip egress guard (e.g. known-safe token endpoints from connector config). */
  skipEgressGuard?: boolean;
}

/** fetch with AbortController timeout and resolve-time SSRF check. */
export async function fetchWithTimeout(
  url: string,
  init?: FetchWithTimeoutInit,
  fetchImpl: FetchLike = fetch,
): Promise<Response> {
  if (!init?.skipEgressGuard) {
    await assertSafeEgress(url);
  }

  const timeoutMs = init?.timeoutMs ?? connectorHttpTimeoutMs();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, {
      ...init,
      signal: controller.signal,
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") {
      throw Object.assign(new Error(`Connector request timed out after ${timeoutMs}ms`), {
        status: 504,
      });
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
