/**
 * SAP Analytics Cloud planning connector via Data Export Service (OData).
 * Thin adapter over connectors/sac/* contract modules.
 */

import { config } from "../config.js";
import {
  administrationProvidersUrl,
  providerRootUrl,
} from "./sac/contract.js";
import { parseCsdl } from "./sac/csdlParser.js";
import { streamFactPages } from "./sac/factData.js";
import { loadDimensions } from "./sac/masterData.js";
import { mapContractToMetadata } from "./sac/mapToPlanning.js";
import { ODataClient, type FetchLike } from "./sac/odataClient.js";
import type {
  ConnectionCredentials,
  FactPage,
  FactQuery,
  PlanningConnector,
  PlanningModelMetadata,
  PlanningModelSummary,
} from "./types.js";

export class SacConnector implements PlanningConnector {
  readonly provider = "sap_sac" as const;
  private creds: ConnectionCredentials;
  private client: ODataClient;
  private authPublic: Record<string, unknown>;
  private metadataCache = new Map<
    string,
    { meta: PlanningModelMetadata; contract: ReturnType<typeof parseCsdl> }
  >();

  constructor(creds: ConnectionCredentials, fetchImpl?: FetchLike) {
    this.creds = creds;
    this.authPublic = creds.authPublic ?? {};
    this.client = new ODataClient({
      auth: creds.auth,
      fetchImpl,
      defaultPageSize: config.SAC_DEFAULT_PAGE_SIZE ?? 1000,
      maxPages: config.SAC_MAX_FACT_PAGES ?? 10_000,
      maxRetries: config.SAC_HTTP_MAX_RETRIES ?? 4,
    });
  }

  private tenantRoot(): string {
    return this.creds.baseUrl;
  }

  async testConnection(): Promise<{ ok: boolean; message?: string }> {
    try {
      await this.client.getAccessToken();
      const url = `${administrationProvidersUrl(this.tenantRoot(), this.authPublic)}?$top=1`;
      await this.client.fetchJson(url);
      return { ok: true, message: "Connected to SAP Analytics Cloud Data Export Service" };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  }

  async listModels(): Promise<PlanningModelSummary[]> {
    const url = administrationProvidersUrl(this.tenantRoot(), this.authPublic);
    const data = (await this.client.fetchJson(url)) as {
      value?: Array<{ ProviderID?: string; Name?: string; Description?: string; providerId?: string }>;
    };
    return (data.value ?? []).map((p) => ({
      id: String(p.ProviderID ?? p.providerId ?? p.Name ?? ""),
      name: String(p.Name ?? p.ProviderID ?? "Model"),
      description: p.Description,
    })).filter((m) => m.id);
  }

  async getModelMetadata(modelId: string): Promise<PlanningModelMetadata> {
    const cached = this.metadataCache.get(modelId);
    if (cached) return cached.meta;

    const root = providerRootUrl(this.tenantRoot(), modelId, this.authPublic);
    const xml = await this.client.fetchText(`${root}/$metadata`);
    const contract = parseCsdl(xml, modelId);
    const dimensions = await loadDimensions(this.client, root, contract);
    const models = await this.listModels().catch(() => []);
    const modelName = models.find((m) => m.id === modelId)?.name ?? modelId;
    const meta = mapContractToMetadata(contract, dimensions, {
      modelName,
      providerRaw: {
        csdlHash: contract.rawCsdlHash,
        dimensionOrder: contract.dimensionOrder,
        metadataXml: xml.slice(0, 50_000),
      },
    });
    this.metadataCache.set(modelId, { meta, contract });
    return meta;
  }

  async *getModelData(modelId: string, query: FactQuery): AsyncIterable<FactPage> {
    const root = providerRootUrl(this.tenantRoot(), modelId, this.authPublic);
    let cached = this.metadataCache.get(modelId);
    if (!cached) {
      await this.getModelMetadata(modelId);
      cached = this.metadataCache.get(modelId)!;
    }
    const aggregates: NonNullable<PlanningModelMetadata["source_aggregates"]> = [];
    for await (const page of streamFactPages(
      this.client,
      root,
      query,
      cached.contract,
      cached.meta,
      (agg) => {
        if (query.includeSourceAggregates !== false) aggregates.push(agg);
      },
    )) {
      yield page;
    }
    if (aggregates.length > 0) {
      cached.meta.source_aggregates = aggregates;
    }
  }
}
