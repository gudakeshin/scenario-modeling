import type {
  FactPage,
  FactQuery,
  PlanningDimension,
  PlanningMember,
  PlanningModelMetadata,
} from "../types.js";
import type { AnaplanClient } from "./client.js";
import type { AnaplanColumnMaps } from "./contract.js";
import { parseCsv } from "./csv.js";
import { slugId } from "../slug.js";

export interface CellDataOptions {
  pollIntervalMs: number;
  pollTimeoutMs: number;
  maxAggregates?: number;
}

type Aggregate = { measure_id: string; member_key: string; value: number };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function requestRecord(body: unknown): Record<string, unknown> {
  const root = asRecord(body) ?? {};
  return asRecord(root.viewReadRequest)
    ?? asRecord(root.readRequest)
    ?? asRecord(root.request)
    ?? root;
}

function requestId(body: unknown): string {
  const record = requestRecord(body);
  const value = record.requestId ?? record.id ?? record.readRequestId;
  if (!value) throw new Error("Anaplan read-request response missing requestId");
  return String(value);
}

function requestState(body: unknown): string {
  const record = requestRecord(body);
  const value = record.requestState ?? record.state ?? record.status;
  if (value && typeof value === "object") {
    return String((value as Record<string, unknown>).state ?? (value as Record<string, unknown>).status ?? "");
  }
  return String(value ?? "").toUpperCase();
}

function pageNumbers(body: unknown): number[] {
  const record = requestRecord(body);
  const value = record.availablePages ?? record.pages ?? record.pageCount;
  if (Array.isArray(value)) {
    return value.map((entry) => Number(
      typeof entry === "object" && entry
        ? (entry as Record<string, unknown>).pageNumber ?? (entry as Record<string, unknown>).number
        : entry,
    )).filter(Number.isFinite);
  }
  const count = Number(value);
  return Number.isFinite(count) && count > 0
    ? Array.from({ length: count }, (_, index) => index)
    : [];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase();
}

function parseNumber(raw: string): number {
  const trimmed = raw.trim();
  if (!trimmed) return Number.NaN;
  const negative = /^\(.*\)$/.test(trimmed);
  const normalized = trimmed
    .replace(/^\((.*)\)$/, "$1")
    .replace(/[$£€¥,\s]/g, "")
    .replace(/%$/, "");
  const value = Number(normalized);
  return negative ? -value : value;
}

function resolveMember(dimension: PlanningDimension, raw: string): PlanningMember | null {
  const normalized = raw.trim();
  return dimension.members.find((member) =>
    member.source_id === normalized
    || member.name === normalized
    || member.id === slugId(normalized),
  ) ?? null;
}

function memberMatchesFilter(
  dimension: PlanningDimension,
  member: PlanningMember,
  allowed: Set<string> | undefined,
): boolean {
  if (!allowed || allowed.size === 0 || allowed.has(member.id)) return true;
  if (member.isLeaf) return false;
  const byId = new Map(dimension.members.map((candidate) => [candidate.id, candidate]));
  return [...allowed].some((allowedId) => {
    let cursor = byId.get(allowedId);
    const visited = new Set<string>();
    while (cursor?.parentId && !visited.has(cursor.id)) {
      if (cursor.parentId === member.id) return true;
      visited.add(cursor.id);
      cursor = byId.get(cursor.parentId);
    }
    return false;
  });
}

interface HeaderMap {
  dimensionColumns: Map<string, number>;
  measureColumn: number;
  valueColumn: number;
}

function mapHeaders(
  headers: string[],
  meta: PlanningModelMetadata,
  columnMaps: AnaplanColumnMaps,
): HeaderMap {
  const dimensionColumns = new Map<string, number>();
  let measureColumn = -1;
  let valueColumn = -1;
  headers.forEach((header, index) => {
    const normalized = normalizeHeader(header);
    const dimensionId = columnMaps.dimensionAliases[normalized];
    if (dimensionId) dimensionColumns.set(dimensionId, index);
    if (/^line[\s_-]*items?$|^line[\s_-]*item$/i.test(normalized)) measureColumn = index;
    if (/^(value|cell value|data)$/i.test(normalized)) valueColumn = index;
  });

  if (measureColumn < 0) {
    measureColumn = headers.findIndex((header) => /line item/i.test(header));
  }
  if (valueColumn < 0) valueColumn = headers.length - 1;
  if (measureColumn < 0 && valueColumn > 0) measureColumn = valueColumn - 1;

  const missing = meta.dimensions.filter((dimension) => !dimensionColumns.has(dimension.id));
  if (missing.length > 0) {
    throw new Error(`Anaplan cell-data page missing dimension columns: ${missing.map((d) => d.name).join(", ")}`);
  }
  if (measureColumn < 0 || valueColumn < 0) {
    throw new Error("Anaplan cell-data page missing Line Items or Value column");
  }
  return { dimensionColumns, measureColumn, valueColumn };
}

function queryFilters(meta: PlanningModelMetadata, query: FactQuery): Map<string, Set<string>> {
  const filters = new Map<string, Set<string>>();
  for (const dimension of meta.dimensions) {
    const values = query.filters?.[dimension.id] ?? query.filters?.[dimension.source_id];
    if (values?.length) filters.set(dimension.id, new Set(values));
    if (dimension.type === "version" && query.versionMemberId) {
      filters.set(dimension.id, new Set([query.versionMemberId]));
    }
    if (dimension.type === "time" && query.timeMemberIds?.length) {
      filters.set(dimension.id, new Set(query.timeMemberIds));
    }
  }
  return filters;
}

function rowsFromCsv(
  csv: string,
  meta: PlanningModelMetadata,
  columnMaps: AnaplanColumnMaps,
  query: FactQuery,
  onAggregate: ((aggregate: Aggregate) => void) | undefined,
  aggregateBudget: { remaining: number },
): FactPage["rows"] {
  const parsed = parseCsv(csv);
  if (parsed.length === 0) return [];
  const headers = parsed[0].map((header) => header.replace(/^\uFEFF/, ""));
  const headerMap = mapHeaders(headers, meta, columnMaps);
  const filters = queryFilters(meta, query);
  const measureFilter = query.measureIds?.length ? new Set(query.measureIds) : null;
  const facts: FactPage["rows"] = [];

  for (const cells of parsed.slice(1)) {
    if (cells.length === 1 && !cells[0]) continue;
    const memberIds: string[] = [];
    let anyNonLeaf = false;
    let complete = true;
    for (const dimension of meta.dimensions) {
      const column = headerMap.dimensionColumns.get(dimension.id)!;
      const member = resolveMember(dimension, cells[column] ?? "");
      if (!member || !memberMatchesFilter(dimension, member, filters.get(dimension.id))) {
        complete = false;
        break;
      }
      memberIds.push(member.id);
      anyNonLeaf ||= !member.isLeaf;
    }
    if (!complete) continue;

    const rawMeasure = cells[headerMap.measureColumn] ?? "";
    const measureId = columnMaps.measureAliases[normalizeHeader(rawMeasure)];
    if (!measureId || (measureFilter && !measureFilter.has(measureId))) continue;
    const value = parseNumber(cells[headerMap.valueColumn] ?? "");
    if (!Number.isFinite(value)) continue;
    const memberKey = memberIds.join("|");
    if (anyNonLeaf) {
      if (query.includeSourceAggregates !== false && aggregateBudget.remaining > 0) {
        aggregateBudget.remaining -= 1;
        onAggregate?.({ measure_id: measureId, member_key: memberKey, value });
      }
    } else {
      facts.push({ measureId, memberKey, value });
    }
  }
  return facts;
}

export async function* streamFactPages(
  client: AnaplanClient,
  modelRoot: string,
  viewId: string,
  query: FactQuery,
  meta: PlanningModelMetadata,
  columnMaps: AnaplanColumnMaps,
  options: CellDataOptions,
  onAggregate?: (aggregate: Aggregate) => void,
): AsyncIterable<FactPage> {
  const readRequestsUrl = `${modelRoot}/views/${encodeURIComponent(viewId)}/readRequests`;
  const created = await client.fetchJson(readRequestsUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ exportType: "TABULAR_SINGLE_COLUMN" }),
  });
  const id = requestId(created);
  const requestUrl = `${readRequestsUrl}/${encodeURIComponent(id)}`;
  const aggregateBudget = { remaining: options.maxAggregates ?? 50_000 };

  try {
    const deadline = Date.now() + options.pollTimeoutMs;
    let status: unknown = created;
    while (requestState(status) !== "COMPLETE") {
      const state = requestState(status);
      if (/FAIL|CANCEL|ERROR/.test(state)) {
        throw new Error(`Anaplan read request ${id} ended in state ${state}`);
      }
      if (Date.now() >= deadline) {
        throw new Error(`Anaplan read request timed out after ${options.pollTimeoutMs}ms`);
      }
      await delay(options.pollIntervalMs);
      status = await client.fetchJson(requestUrl);
    }

    const pages = pageNumbers(status);
    for (let index = 0; index < pages.length; index += 1) {
      const pageNumber = pages[index];
      const csv = await client.fetchText(`${requestUrl}/pages/${pageNumber}`, {
        headers: { Accept: "text/csv" },
      });
      yield {
        rows: rowsFromCsv(csv, meta, columnMaps, query, onAggregate, aggregateBudget),
        nextPageToken: index + 1 < pages.length ? String(pages[index + 1]) : undefined,
      };
    }
  } finally {
    await client.fetchRaw(requestUrl, { method: "DELETE" }).catch(() => undefined);
  }
}
