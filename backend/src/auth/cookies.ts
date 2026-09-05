/**
 * Auth cookie helpers — httpOnly refresh token + session hint for SSR.
 */

import type { Response, Request } from "express";
import { config } from "../config.js";

export const REFRESH_COOKIE = "sm_refresh";
export const SESSION_HINT_COOKIE = "sm_session";

function serializeCookie(
  name: string,
  value: string,
  opts: {
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: "Strict" | "Lax" | "None";
    path?: string;
    maxAgeSec?: number;
  },
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (opts.maxAgeSec != null) parts.push(`Max-Age=${opts.maxAgeSec}`);
  if (opts.path) parts.push(`Path=${opts.path}`);
  if (opts.httpOnly) parts.push("HttpOnly");
  if (opts.secure) parts.push("Secure");
  if (opts.sameSite) parts.push(`SameSite=${opts.sameSite}`);
  return parts.join("; ");
}

function appendSetCookie(res: Response, cookie: string): void {
  const existing = res.getHeader("Set-Cookie");
  if (!existing) {
    res.setHeader("Set-Cookie", cookie);
    return;
  }
  const list = Array.isArray(existing) ? existing : [String(existing)];
  res.setHeader("Set-Cookie", [...list, cookie]);
}

export function setAuthCookies(res: Response, refreshToken: string): void {
  const secure = config.NODE_ENV === "production";
  appendSetCookie(
    res,
    serializeCookie(REFRESH_COOKIE, refreshToken, {
      httpOnly: true,
      secure,
      sameSite: "Strict",
      path: "/api/v1/auth",
      maxAgeSec: config.REFRESH_TOKEN_TTL_SEC,
    }),
  );
  appendSetCookie(
    res,
    serializeCookie(SESSION_HINT_COOKIE, "1", {
      httpOnly: false,
      secure,
      sameSite: "Strict",
      path: "/",
      maxAgeSec: config.REFRESH_TOKEN_TTL_SEC,
    }),
  );
}

export function clearAuthCookies(res: Response): void {
  const secure = config.NODE_ENV === "production";
  for (const [name, path] of [
    [REFRESH_COOKIE, "/api/v1/auth"],
    [SESSION_HINT_COOKIE, "/"],
  ] as const) {
    appendSetCookie(
      res,
      serializeCookie(name, "", {
        httpOnly: name === REFRESH_COOKIE,
        secure,
        sameSite: "Strict",
        path,
        maxAgeSec: 0,
      }),
    );
  }
}

/** Parse a named cookie from the raw Cookie header. */
export function readCookie(req: Request, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) {
      try {
        return decodeURIComponent(rest.join("="));
      } catch {
        return rest.join("=");
      }
    }
  }
  return undefined;
}

export function readRefreshToken(req: Request, bodyToken?: string): string | undefined {
  const fromCookie = readCookie(req, REFRESH_COOKIE);
  if (fromCookie) return fromCookie;
  if (config.AUTH_REFRESH_BODY_FALLBACK) return bodyToken;
  return undefined;
}
