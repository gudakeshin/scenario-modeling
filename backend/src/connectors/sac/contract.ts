/**
 * SAC Data Export Service URL contract and shared constants.
 */
export { slugId } from "../slug.js";

export const DEFAULT_DES_BASE_PATH = "/api/v1/dataexport";
export const DEFAULT_NAMESPACE = "sac";
export const DEFAULT_PAGE_SIZE = 1000;
export const MAX_PAGE_SIZE = 5000;

export const ACCOUNT_SIGN: Record<string, 1 | -1> = {
  INC: -1,
  LEQ: -1,
  EXP: 1,
  AST: 1,
};

export function normalizeTenantRoot(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/api\/v1\/dataexport.*$/i, "");
}

export function desBasePath(authPublic?: Record<string, unknown>): string {
  const raw = String(authPublic?.des_base_path ?? authPublic?.desBasePath ?? DEFAULT_DES_BASE_PATH);
  return raw.startsWith("/") ? raw.replace(/\/+$/, "") : `/${raw.replace(/\/+$/, "")}`;
}

export function namespaceId(authPublic?: Record<string, unknown>): string {
  return String(authPublic?.namespace_id ?? authPublic?.namespaceId ?? DEFAULT_NAMESPACE);
}

export function administrationProvidersUrl(
  tenantRoot: string,
  authPublic?: Record<string, unknown>,
): string {
  const ns = namespaceId(authPublic);
  return `${normalizeTenantRoot(tenantRoot)}${desBasePath(authPublic)}/administration/Namespaces(NamespaceID='${ns}')/Providers`;
}

export function providerRootUrl(
  tenantRoot: string,
  providerId: string,
  authPublic?: Record<string, unknown>,
): string {
  const ns = namespaceId(authPublic);
  return `${normalizeTenantRoot(tenantRoot)}${desBasePath(authPublic)}/providers/${ns}/${encodeURIComponent(providerId)}`;
}

export function inferDimensionType(name: string): "account" | "time" | "version" | "generic" {
  if (/account/i.test(name)) return "account";
  if (/time|date|period|calendar|fiscal/i.test(name)) return "time";
  if (/version|category/i.test(name)) return "version";
  return "generic";
}

export function accountSign(accountType: unknown): 1 | -1 {
  const key = String(accountType ?? "").trim().toUpperCase();
  return ACCOUNT_SIGN[key] ?? 1;
}
