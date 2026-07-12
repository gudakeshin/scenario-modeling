/**
 * Connector registry — decrypt secrets and dispatch by provider.
 */

import { decryptSecret } from "../services/secretVault.js";
import { MockConnector } from "./mockConnector.js";
import { SacConnector } from "./sacConnector.js";
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

export function createConnector(row: ConnectionRow): PlanningConnector {
  const secretPlain = decryptSecret(row.secret_ciphertext);
  const auth = buildAuth(row, secretPlain);
  const creds: ConnectionCredentials = {
    connectionId: row.connection_id,
    provider: row.provider,
    baseUrl: row.base_url,
    auth,
    authPublic: row.auth_public || {},
    fixturePath: row.fixture_path || undefined,
  };

  switch (row.provider) {
    case "sap_sac":
      return new SacConnector(creds);
    case "mock":
      return new MockConnector(creds);
    case "anaplan":
    case "oracle_pbcs":
      throw new Error(`Provider '${row.provider}' is not implemented yet`);
    default:
      throw new Error(`Unknown planning provider: ${row.provider}`);
  }
}
