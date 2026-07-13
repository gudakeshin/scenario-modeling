/**
 * Anaplan connector — read/import implementing PlanningConnector.
 * When credentials are missing, operates in documented mock mode so
 * listModels / getModelMetadata / getModelData remain usable in demos.
 */

import type {
  ConnectionCredentials,
  FactPage,
  FactQuery,
  PlanningConnector,
  PlanningModelMetadata,
  PlanningModelSummary,
} from "./types.js";
import { config } from "../config.js";
import { AnaplanClient, type FetchLike } from "./anaplan/client.js";
import { streamFactPages } from "./anaplan/cellData.js";
import {
  encodeCompositeModelId,
  modelApiRoot,
  normalizeAnaplanBaseUrl,
  parseCompositeModelId,
  type AnaplanColumnMaps,
} from "./anaplan/contract.js";
import { buildModuleMetadata } from "./anaplan/metadata.js";

const MOCK_MODELS: PlanningModelSummary[] = [
  { id: "mock-anaplan-pl", name: "P&L Planning (mock)", description: "Demo Anaplan model" },
  { id: "mock-anaplan-hr", name: "Headcount (mock)", description: "Demo workforce model" },
];

function mockMetadata(modelId: string): PlanningModelMetadata {
  const summary = MOCK_MODELS.find((m) => m.id === modelId);
  return {
    modelId,
    modelName: summary?.name || modelId,
    dimensions: [
      {
        id: "time",
        source_id: "Time",
        name: "Time",
        type: "time",
        members: [
          {
            id: "fy2025",
            source_id: "FY2025",
            name: "FY2025",
            parentId: null,
            isLeaf: false,
            sign: 1,
            ordinal: 0,
          },
          {
            id: "q1",
            source_id: "Q1",
            name: "Q1",
            parentId: "fy2025",
            isLeaf: true,
            sign: 1,
            ordinal: 1,
          },
          {
            id: "q2",
            source_id: "Q2",
            name: "Q2",
            parentId: "fy2025",
            isLeaf: true,
            sign: 1,
            ordinal: 2,
          },
        ],
        hierarchies: [{ id: "time_h", name: "Time", rootMemberIds: ["fy2025"] }],
        defaultHierarchyId: "time_h",
      },
      {
        id: "version",
        source_id: "Version",
        name: "Version",
        type: "version",
        members: [
          {
            id: "budget",
            source_id: "Budget",
            name: "Budget",
            parentId: null,
            isLeaf: true,
            sign: 1,
            ordinal: 0,
          },
          {
            id: "forecast",
            source_id: "Forecast",
            name: "Forecast",
            parentId: null,
            isLeaf: true,
            sign: 1,
            ordinal: 1,
          },
        ],
        hierarchies: [{ id: "version_h", name: "Version", rootMemberIds: ["budget", "forecast"] }],
      },
      {
        id: "account",
        source_id: "Account",
        name: "Account",
        type: "account",
        members: [
          {
            id: "revenue",
            source_id: "Revenue",
            name: "Revenue",
            parentId: null,
            isLeaf: true,
            sign: 1,
            ordinal: 0,
          },
          {
            id: "cogs",
            source_id: "COGS",
            name: "COGS",
            parentId: null,
            isLeaf: true,
            sign: -1,
            ordinal: 1,
          },
        ],
        hierarchies: [{ id: "account_h", name: "Account", rootMemberIds: ["revenue", "cogs"] }],
      },
    ],
    measures: [
      {
        id: "amount",
        source_id: "Amount",
        name: "Amount",
        unit: "USD",
        aggregation: "sum",
      },
    ],
    providerRaw: {
      provider: "anaplan",
      mock: true,
      note: "Mock metadata — configure Anaplan credentials for live API",
    },
  };
}

export class AnaplanConnector implements PlanningConnector {
  readonly provider = "anaplan" as const;
  private readonly client: AnaplanClient;
  private readonly metadataCache = new Map<
    string,
    { meta: PlanningModelMetadata; columnMaps: AnaplanColumnMaps }
  >();
  private readonly summaryCache = new Map<string, PlanningModelSummary>();

  constructor(
    private readonly creds: ConnectionCredentials,
    fetchImpl?: FetchLike,
  ) {
    this.client = new AnaplanClient({
      auth: creds.auth,
      fetchImpl,
      maxRetries: config.ANAPLAN_HTTP_MAX_RETRIES,
    });
  }

  /** True when auth secrets are absent — use documented mock responses. */
  isMockMode(): boolean {
    if (this.creds.baseUrl.trim().toLowerCase() === "mock://local") return true;
    const auth = this.creds.auth;
    if (!auth) return true;
    if (auth.kind === "api_key") return !auth.apiKey;
    if (auth.kind === "oauth2_client_credentials") {
      return !auth.clientId || !auth.clientSecret;
    }
    return true;
  }

  async testConnection(): Promise<{ ok: boolean; message?: string }> {
    if (this.isMockMode()) {
      return { ok: true, message: "Anaplan mock mode (no credentials)" };
    }
    try {
      const base = normalizeAnaplanBaseUrl(this.creds.baseUrl);
      await this.client.fetchJson(`${base}/users/me`);
      const workspaceId = this.workspaceId(false);
      if (workspaceId) {
        const body = await this.client.fetchJson(
          `${base}/workspaces/${encodeURIComponent(workspaceId)}`,
        ) as { name?: string; workspace?: { name?: string } };
        const name = body.workspace?.name ?? body.name ?? workspaceId;
        return { ok: true, message: `Connected to Anaplan workspace ${name}` };
      }
      return { ok: true, message: "Anaplan connection OK" };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  }

  async listModels(): Promise<PlanningModelSummary[]> {
    if (this.isMockMode()) return MOCK_MODELS;

    const workspaceId = this.workspaceId();
    const base = normalizeAnaplanBaseUrl(this.creds.baseUrl);
    const body = await this.client.fetchJson(
      `${base}/workspaces/${encodeURIComponent(workspaceId)}/models`,
    ) as {
      models?: Array<{ id: string; name: string; activeState?: string }>;
    };
    const models = body.models ?? [];
    const summaries: PlanningModelSummary[] = [];
    const concurrency = 4;
    for (let offset = 0; offset < models.length; offset += concurrency) {
      const batch = await Promise.all(models.slice(offset, offset + concurrency).map(async (model) => {
        const root = `${base}/workspaces/${encodeURIComponent(workspaceId)}/models/${encodeURIComponent(model.id)}`;
        const moduleBody = await this.client.fetchJson(`${root}/modules`) as {
          modules?: Array<{ id: string; name: string }>;
          items?: Array<{ id: string; name: string }>;
        };
        const modules = (moduleBody.modules ?? moduleBody.items ?? [])
          .slice(0, config.ANAPLAN_MAX_MODULES_PER_MODEL);
        return modules.map((module) => ({
          id: encodeCompositeModelId(model.id, module.id),
          name: `${model.name} · ${module.name}`,
          description: model.activeState,
        }));
      }));
      for (const modelSummaries of batch) {
        for (const summary of modelSummaries) {
          summaries.push(summary);
          this.summaryCache.set(summary.id, summary);
        }
      }
    }
    return summaries;
  }

  async getModelMetadata(modelId: string): Promise<PlanningModelMetadata> {
    if (this.isMockMode()) return mockMetadata(modelId);
    const cached = this.metadataCache.get(modelId);
    if (cached) return cached.meta;

    const { modelId: sourceModelId, moduleId } = parseCompositeModelId(modelId);
    let summary = this.summaryCache.get(modelId);
    if (!summary) {
      await this.listModels();
      summary = this.summaryCache.get(modelId);
    }
    const [modelName, moduleName] = summary?.name.split(" · ") ?? [sourceModelId, moduleId];
    const built = await buildModuleMetadata(
      this.client,
      modelApiRoot(this.creds.baseUrl, sourceModelId),
      {
        modelId: sourceModelId,
        moduleId,
        modelName,
        moduleName,
      },
    );
    this.metadataCache.set(modelId, built);
    return built.meta;
  }

  async *getModelData(modelId: string, query: FactQuery): AsyncIterable<FactPage> {
    if (this.isMockMode()) {
      const pageSize = query.pageSize || 100;
      yield {
        rows: [
          {
            measureId: "amount",
            memberKey: "q1|budget|revenue",
            value: 1_250_000,
          },
          {
            measureId: "amount",
            memberKey: "q2|budget|revenue",
            value: 1_310_000,
          },
          {
            measureId: "amount",
            memberKey: "q1|budget|cogs",
            value: 480_000,
          },
        ].slice(0, pageSize),
      };
      return;
    }
    let cached = this.metadataCache.get(modelId);
    if (!cached) {
      await this.getModelMetadata(modelId);
      cached = this.metadataCache.get(modelId)!;
    }
    const { modelId: sourceModelId, moduleId } = parseCompositeModelId(modelId);
    const aggregates: NonNullable<PlanningModelMetadata["source_aggregates"]> = [];
    for await (const page of streamFactPages(
      this.client,
      modelApiRoot(this.creds.baseUrl, sourceModelId),
      moduleId,
      query,
      cached.meta,
      cached.columnMaps,
      {
        pollIntervalMs: config.ANAPLAN_READ_POLL_INTERVAL_MS,
        pollTimeoutMs: config.ANAPLAN_READ_POLL_TIMEOUT_MS,
      },
      (aggregate) => aggregates.push(aggregate),
    )) {
      yield page;
    }
    cached.meta.source_aggregates = aggregates;
  }

  private workspaceId(required = true): string {
    const value = String(
      this.creds.authPublic?.workspace_id ?? this.creds.authPublic?.workspaceId ?? "",
    ).trim();
    if (required && !value) throw new Error("Anaplan requires auth_public.workspace_id");
    return value;
  }
}
