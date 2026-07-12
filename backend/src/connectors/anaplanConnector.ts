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

  constructor(private readonly creds: ConnectionCredentials) {}

  /** True when auth secrets are absent — use documented mock responses. */
  isMockMode(): boolean {
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
      const token = await this.getAuthHeader();
      const res = await fetch(`${this.creds.baseUrl.replace(/\/$/, "")}/users/me`, {
        headers: { Authorization: token, Accept: "application/json" },
      });
      if (!res.ok) {
        return { ok: false, message: `Anaplan auth failed (${res.status})` };
      }
      return { ok: true, message: "Anaplan connection OK" };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  }

  async listModels(): Promise<PlanningModelSummary[]> {
    if (this.isMockMode()) return MOCK_MODELS;

    const token = await this.getAuthHeader();
    const workspaceId = String(
      this.creds.authPublic?.workspace_id || this.creds.authPublic?.workspaceId || "",
    );
    if (!workspaceId) {
      throw new Error("Anaplan requires auth_public.workspace_id");
    }
    const url = `${this.creds.baseUrl.replace(/\/$/, "")}/workspaces/${workspaceId}/models`;
    const res = await fetch(url, {
      headers: { Authorization: token, Accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(`Anaplan listModels failed (${res.status})`);
    }
    const body = (await res.json()) as {
      models?: Array<{ id: string; name: string; activeState?: string }>;
    };
    return (body.models || []).map((m) => ({
      id: m.id,
      name: m.name,
      description: m.activeState,
    }));
  }

  async getModelMetadata(modelId: string): Promise<PlanningModelMetadata> {
    if (this.isMockMode()) return mockMetadata(modelId);

    // Live: list modules as a lightweight dimension/measure stub from Anaplan shapes
    try {
      const token = await this.getAuthHeader();
      const workspaceId = String(
        this.creds.authPublic?.workspace_id || this.creds.authPublic?.workspaceId || "",
      );
      const base = this.creds.baseUrl.replace(/\/$/, "");
      const url = `${base}/workspaces/${workspaceId}/models/${modelId}/modules`;
      const res = await fetch(url, {
        headers: { Authorization: token, Accept: "application/json" },
      });
      if (res.ok) {
        const body = (await res.json()) as {
          modules?: Array<{ id: string; name: string }>;
        };
        const modules = body.modules || [];
        return {
          modelId,
          modelName: modelId,
          dimensions: [
            {
              id: "time",
              source_id: "time",
              name: "Time",
              type: "time",
              members: [],
              hierarchies: [],
            },
            {
              id: "version",
              source_id: "version",
              name: "Version",
              type: "version",
              members: [],
              hierarchies: [],
            },
          ],
          measures: modules.slice(0, 20).map((m) => ({
            id: m.id,
            source_id: m.id,
            name: m.name,
            aggregation: "sum" as const,
          })),
          providerRaw: { provider: "anaplan", modules },
        };
      }
    } catch {
      /* fall through to stubs */
    }
    return {
      modelId,
      modelName: modelId,
      dimensions: [
        {
          id: "time",
          source_id: "time",
          name: "Time",
          type: "time",
          members: [],
          hierarchies: [],
        },
        {
          id: "version",
          source_id: "version",
          name: "Version",
          type: "version",
          members: [],
          hierarchies: [],
        },
      ],
      measures: [],
      providerRaw: { provider: "anaplan", note: "Configure module/view mapping at import" },
    };
  }

  async *getModelData(modelId: string, query: FactQuery): AsyncIterable<FactPage> {
    if (this.isMockMode()) {
      const pageSize = query.pageSize || 100;
      yield {
        rows: [
          {
            measureId: "amount",
            memberKey: "revenue|q1|budget",
            value: 1_250_000,
          },
          {
            measureId: "amount",
            memberKey: "revenue|q2|budget",
            value: 1_310_000,
          },
          {
            measureId: "amount",
            memberKey: "cogs|q1|budget",
            value: 480_000,
          },
        ].slice(0, pageSize),
      };
      return;
    }
    // Live export-action streaming is configured per connection; empty page until mapped.
    yield { rows: [] };
  }

  private async getAuthHeader(): Promise<string> {
    const auth = this.creds.auth;
    if (auth.kind === "api_key") {
      return `AnaplanAuthToken ${auth.apiKey}`;
    }
    const tokenUrl = auth.tokenUrl || "https://auth.anaplan.com/token/authenticate";
    const basic = Buffer.from(`${auth.clientId}:${auth.clientSecret}`).toString("base64");
    const res = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/json",
      },
    });
    if (!res.ok) throw new Error(`Anaplan token exchange failed (${res.status})`);
    const body = (await res.json()) as {
      tokenInfo?: { tokenValue?: string };
      access_token?: string;
    };
    const token = body.tokenInfo?.tokenValue || body.access_token;
    if (!token) throw new Error("Anaplan token response missing tokenValue");
    return `AnaplanAuthToken ${token}`;
  }
}
