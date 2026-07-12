/**
 * Connector registry — decrypt secrets and dispatch by provider.
 */

import { decryptSecret } from "../services/secretVault.js";
import { MockConnector } from "./mockConnector.js";
import { SacConnector } from "./sacConnector.js";
import { AnaplanConnector } from "./anaplanConnector.js";
import type {
  AuthKind,
  ConnectionCredentials,
  ConnectorAuth,
  PlanningConnector,
  PlanningProvider,
} from "./types.js";

/** Safe public columns from planning_connections (never includes secret_ciphertext). */
export interface ConnectionRow {
  connection_id: string;
  workspace_id: string;
  provider: PlanningProvider;
  name: string;
  base_url: string;
  auth_kind: AuthKind;
  auth_public: Record<string, unknown>;
  secret_ciphertext: string;
  status: string;
  fixture_path?: string | null;
}

function buildAuth(row: ConnectionRow, secretPlain: string): ConnectorAuth {
  if (row.auth_kind === "api_key") {
    return { kind: "api_key", apiKey: secretPlain };
  }
  const pub = row.auth_public || {};
  return {
    kind: "oauth2_client_credentials",
    tokenUrl: String(pub.token_url || pub.tokenUrl || ""),
    clientId: String(pub.client_id || pub.clientId || ""),
    clientSecret: secretPlain,
  };
}

function connectorFromCreds(creds: ConnectionCredentials): PlanningConnector {
  switch (creds.provider) {
    case "sap_sac":
      return new SacConnector(creds);
    case "mock":
      return new MockConnector(creds);
    case "anaplan":
      return new AnaplanConnector(creds);
    case "oracle_pbcs":
      throw new Error(`Provider '${creds.provider}' is not implemented yet`);
    default:
      throw new Error(`Unknown planning provider: ${creds.provider}`);
  }
}

export function createConnector(row: ConnectionRow): PlanningConnector {
  const secretPlain = decryptSecret(row.secret_ciphertext);
  const auth = buildAuth(row, secretPlain);
  return connectorFromCreds({
    connectionId: row.connection_id,
    provider: row.provider,
    baseUrl: row.base_url,
    auth,
    authPublic: row.auth_public || {},
    fixturePath: row.fixture_path || undefined,
  });
}

/** Build a connector from unsaved draft credentials (no DB row). */
export function createConnectorFromDraft(opts: {
  provider: PlanningProvider;
  base_url: string;
  auth_kind: AuthKind;
  auth_public?: Record<string, unknown>;
  secret: string;
}): PlanningConnector {
  const row: ConnectionRow = {
    connection_id: "draft",
    workspace_id: "draft",
    provider: opts.provider,
    name: "draft",
    base_url: opts.base_url,
    auth_kind: opts.auth_kind,
    auth_public: opts.auth_public || {},
    secret_ciphertext: "", // unused — we pass plaintext via buildAuth
    status: "active",
  };
  const auth = buildAuth(row, opts.secret);
  return connectorFromCreds({
    connectionId: "draft",
    provider: opts.provider,
    baseUrl: opts.base_url,
    auth,
    authPublic: opts.auth_public || {},
  });
}
