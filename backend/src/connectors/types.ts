/**
 * Provider-agnostic planning connector types.
 * Implemented by sacConnector, mockConnector; Anaplan/PBCS later.
 */

export type PlanningProvider = "sap_sac" | "anaplan" | "oracle_pbcs" | "mock";

export type AuthKind = "oauth2_client_credentials" | "api_key";

export type ConnectorAuth =
  | {
      kind: "oauth2_client_credentials";
      tokenUrl: string;
      clientId: string;
      clientSecret: string;
    }
  | {
      kind: "api_key";
      apiKey: string;
    };

export type DimensionType = "generic" | "account" | "time" | "version";

export interface PlanningMember {
  id: string;
  /** Original id from the source system (before any slug). */
  source_id: string;
  name: string;
  parentId: string | null;
  isLeaf: boolean;
  /** Account signage: +1 revenue/asset style, -1 expense/liability style. Non-account dims use 1. */
  sign: 1 | -1;
  attributes?: Record<string, unknown>;
  ordinal: number;
}

export interface PlanningHierarchy {
  id: string;
  name: string;
  /** Root member ids in this hierarchy. */
  rootMemberIds: string[];
}

export interface PlanningDimension {
  id: string;
  source_id: string;
  name: string;
  type: DimensionType;
  members: PlanningMember[];
  hierarchies: PlanningHierarchy[];
  defaultHierarchyId?: string;
}

export interface PlanningMeasure {
  id: string;
  source_id: string;
  name: string;
  unit?: string;
  aggregation?: "sum" | "avg" | "last";
  /** Source-exposed formula text when available. */
  formula?: string;
  attributes?: Record<string, unknown>;
}

export interface PlanningModelSummary {
  id: string;
  name: string;
  description?: string;
}

export interface PlanningModelMetadata {
  modelId: string;
  modelName: string;
  dimensions: PlanningDimension[];
  measures: PlanningMeasure[];
  /** Non-leaf aggregates from source for cross-footing (optional). */
  source_aggregates?: Array<{
    measure_id: string;
    member_key: string;
    value: number;
  }>;
  /** Verbatim provider payload fragments for audit / re-parse. */
  providerRaw?: unknown;
}

export interface FactQuery {
  /** Dimension id → member ids to include (empty/missing = all leaves). */
  filters?: Record<string, string[]>;
  pageSize?: number;
  /** Version member id when the model has a Version dimension. */
  versionMemberId?: string;
  /** Time member ids (inclusive range selection from wizard). */
  timeMemberIds?: string[];
  /** Advanced escape hatch — validated OData $filter fragment. */
  odataFilterRaw?: string;
  /** When true (default), non-leaf fact tuples are collected as source_aggregates. */
  includeSourceAggregates?: boolean;
}

export interface FactRow {
  measureId: string;
  /** '|' joined leaf member ids in dimension order. */
  memberKey: string;
  value: number;
}

export interface FactPage {
  rows: FactRow[];
  nextPageToken?: string;
}

export interface PlanningConnector {
  readonly provider: PlanningProvider;
  testConnection(): Promise<{ ok: boolean; message?: string }>;
  listModels(): Promise<PlanningModelSummary[]>;
  getModelMetadata(modelId: string): Promise<PlanningModelMetadata>;
  getModelData(modelId: string, query: FactQuery): AsyncIterable<FactPage>;
}

/** Row shape used to construct a connector (secrets already decrypted by registry). */
export interface ConnectionCredentials {
  connectionId: string;
  provider: PlanningProvider;
  baseUrl: string;
  auth: ConnectorAuth;
  /** Non-secret auth/public connection settings (namespace, DES path, OAuth public fields). */
  authPublic?: Record<string, unknown>;
  /** Optional fixture path override for mock connector. */
  fixturePath?: string;
}
