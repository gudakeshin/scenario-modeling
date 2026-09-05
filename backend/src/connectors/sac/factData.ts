/**
 * FactData streaming: leaf facts vs source aggregates, multi-measure rows.
 */

import type {
  FactPage,
  FactQuery,
  FactRow,
  PlanningModelMetadata,
} from "../types.js";
import { measureSlug, type SacModelContract } from "./csdlParser.js";
import { buildFactDataUrl } from "./filterBuilder.js";
import type { ODataClient } from "./odataClient.js";
import { slugId } from "./contract.js";

function pick(row: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) {
    if (row[k] != null && row[k] !== "") return row[k];
    const hit = Object.entries(row).find(([key]) => key.toLowerCase() === k.toLowerCase());
    if (hit && hit[1] != null && hit[1] !== "") return hit[1];
  }
  return undefined;
}

function resolveMemberSlug(
  meta: PlanningModelMetadata,
  dimSourceOrId: string,
  rawValue: string,
): { slug: string; isLeaf: boolean } | null {
  const dim =
    meta.dimensions.find((d) => d.source_id === dimSourceOrId || d.id === dimSourceOrId) ??
    meta.dimensions.find((d) => d.name === dimSourceOrId);
  if (!dim) {
    return { slug: slugId(rawValue), isLeaf: true };
  }
  const member =
    dim.members.find((m) => m.source_id === rawValue || m.id === slugId(rawValue)) ??
    dim.members.find((m) => m.name === rawValue);
  if (!member) return null;
  return { slug: member.id, isLeaf: member.isLeaf };
}

export interface FactStreamResult {
  pages: AsyncIterable<FactPage>;
  sourceAggregates: Array<{ measure_id: string; member_key: string; value: number }>;
}

export async function* streamFactPages(
  client: ODataClient,
  providerRoot: string,
  query: FactQuery,
  contract: SacModelContract,
  meta: PlanningModelMetadata,
  onAggregate?: (row: { measure_id: string; member_key: string; value: number }) => void,
): AsyncIterable<FactPage> {
  const pageSize = Math.min(query.pageSize ?? client.defaultPageSize, 5000);
  const startUrl = buildFactDataUrl(providerRoot, query, contract, meta, pageSize);

  for await (const page of client.paginateJson(startUrl)) {
    const leafRows: FactRow[] = [];
    for (const raw of page.value) {
      if (!raw || typeof raw !== "object") continue;
      const row = raw as Record<string, unknown>;

      const dimParts: string[] = [];
      let complete = true;
      let anyNonLeaf = false;
      for (const dimProp of contract.dimensionOrder) {
        const rawVal = pick(row, dimProp);
        if (rawVal == null || rawVal === "") {
          complete = false;
          break;
        }
        const resolved = resolveMemberSlug(meta, dimProp, String(rawVal));
        if (!resolved) {
          complete = false;
          break;
        }
        dimParts.push(resolved.slug);
        if (!resolved.isLeaf) anyNonLeaf = true;
      }
      if (!complete) continue;
      const memberKey = dimParts.join("|");

      for (const measure of contract.measures) {
        const value = Number(
          pick(row, measure.sourceProperty, "SignedData", "Value", "Amount", "value"),
        );
        if (!Number.isFinite(value)) continue;
        const measureId = measureSlug(measure.sourceProperty);
        if (anyNonLeaf) {
          onAggregate?.({ measure_id: measureId, member_key: memberKey, value });
        } else {
          leafRows.push({ measureId, memberKey, value });
        }
      }
    }
    yield { rows: leafRows, nextPageToken: page.nextLink };
  }
}

export async function collectSourceAggregates(
  client: ODataClient,
  providerRoot: string,
  query: FactQuery,
  contract: SacModelContract,
  meta: PlanningModelMetadata,
): Promise<Array<{ measure_id: string; member_key: string; value: number }>> {
  const aggregates: Array<{ measure_id: string; member_key: string; value: number }> = [];
  if (query.includeSourceAggregates === false) return aggregates;
  // Single pass during stream is preferred; this helper exists for tests.
  for await (const _ of streamFactPages(
    client,
    providerRoot,
    { ...query, includeSourceAggregates: true },
    contract,
    meta,
    (agg) => aggregates.push(agg),
  )) {
    // drain
  }
  return aggregates;
}
