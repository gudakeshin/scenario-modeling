/**
 * SSRF egress guard for planning connector URLs.
 * Validates at schema time (sync) and resolves DNS at request time (rebinding defense).
 */

import dns from "node:dns/promises";
import { isIP } from "node:net";
import { URL } from "node:url";
import { config } from "../config.js";

const MOCK_LOCAL = "mock://local";

/** RFC1918, loopback, link-local, metadata, CGNAT, etc. */
function isPrivateOrReservedIp(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) {
    const parts = ip.split(".").map(Number);
    const [a, b] = parts;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // multicast / reserved
    return false;
  }
  if (kind === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::1") return true;
    if (lower.startsWith("fe80:")) return true; // link-local
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA
    if (lower.startsWith("::ffff:")) {
      const mapped = lower.slice("::ffff:".length);
      if (isIP(mapped) === 4) return isPrivateOrReservedIp(mapped);
    }
    return false;
  }
  return false;
}

function hostnameBlocked(hostname: string): string | null {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (h === "localhost" || h.endsWith(".localhost")) return "localhost is not allowed";
  if (h === "metadata.google.internal") return "metadata endpoints are not allowed";
  if (h === "169.254.169.254") return "cloud metadata IP is not allowed";
  return null;
}

function allowlist(): Set<string> {
  const raw = process.env.CONNECTOR_EGRESS_ALLOWLIST || "";
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** Synchronous URL policy — used by Zod superRefine (no DNS). */
export function validateEgressUrl(url: string): { ok: true } | { ok: false; message: string } {
  if (url === MOCK_LOCAL) return { ok: true };

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, message: "Invalid URL" };
  }

  if (config.NODE_ENV === "production" && parsed.protocol !== "https:") {
    return { ok: false, message: "Only https URLs are allowed in production" };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, message: "Only http(s) URLs are allowed" };
  }

  const host = parsed.hostname.toLowerCase();
  const listed = allowlist();
  if (listed.has(host)) return { ok: true };

  const hostErr = hostnameBlocked(host);
  if (hostErr) return { ok: false, message: hostErr };

  const ipKind = isIP(host);
  if (ipKind && isPrivateOrReservedIp(host)) {
    return { ok: false, message: "Private or reserved IP addresses are not allowed" };
  }

  return { ok: true };
}

/** Resolve-time check — rejects DNS rebinding to private ranges. */
export async function assertSafeEgress(url: string): Promise<void> {
  const sync = validateEgressUrl(url);
  if (!sync.ok) {
    throw Object.assign(new Error(sync.message), { status: 400 });
  }
  if (url === MOCK_LOCAL) return;

  const parsed = new URL(url);
  const host = parsed.hostname;
  const listed = allowlist();
  if (listed.has(host.toLowerCase())) return;

  if (isIP(host)) {
    if (isPrivateOrReservedIp(host)) {
      throw Object.assign(new Error("Private or reserved IP addresses are not allowed"), {
        status: 400,
      });
    }
    return;
  }

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await dns.lookup(host, { all: true, verbatim: true });
  } catch (e) {
    throw Object.assign(new Error(`DNS lookup failed for ${host}: ${(e as Error).message}`), {
      status: 400,
    });
  }

  for (const { address } of addresses) {
    if (isPrivateOrReservedIp(address)) {
      throw Object.assign(
        new Error(`URL resolves to blocked address ${address}`),
        { status: 400 },
      );
    }
  }
}

/** Zod superRefine helper for connection base_url fields. */
export function refineEgressUrl(
  url: string,
  // Zod's internal ctx type is IssueData-based; we only care about message strings.
  // Using a wide type avoids TS coupling to Zod's internal IssueData shape.
  ctx: { addIssue: (issue: any) => void },
) {
  const result = validateEgressUrl(url);
  if (!result.ok) ctx.addIssue({ message: result.message });
}
