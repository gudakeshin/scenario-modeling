/**
 * Auth provider factory — local JWT (default) or OIDC.
 */

import { config } from "../config.js";
import type { AuthProvider } from "./provider.js";
import { LocalAuthProvider } from "./localProvider.js";
import { OidcAuthProvider } from "./oidcProvider.js";

let _provider: AuthProvider | null = null;
let _local: LocalAuthProvider | null = null;

export function getLocalAuthProvider(): LocalAuthProvider {
  if (!_local) _local = new LocalAuthProvider();
  return _local;
}

export function getAuthProvider(): AuthProvider {
  if (_provider) return _provider;
  if (config.AUTH_PROVIDER === "oidc") {
    _provider = new OidcAuthProvider();
  } else {
    _provider = getLocalAuthProvider();
  }
  return _provider;
}
