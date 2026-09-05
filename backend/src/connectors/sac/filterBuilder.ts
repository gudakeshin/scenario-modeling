/**
 * Build OData $filter from FactQuery using CSDL property names + leaf expansion.
 */

import type { FactQuery, PlanningModelMetadata } from "../types.js";
import type { SacModelContract } from "./csdlParser.js";

function odataEscape(v: string): string {
  return v.replace(/'/g, "''");
}

function leafSourceIds(
  meta: PlanningModelMetadata,
  dimIdOrSource: string,
  memberSlugOrSource: string,
): string[] {
  const dim =
    meta.dimensions.find((d) => d.id === dimIdOrSource || d.source_id === dimIdOrSource) ??
    meta.dimensions.find((d) => d.name === dimIdOrSource);
  if (!dim) return [memberSlugOrSource];

  const member =
    dim.members.find((m) => m.id === memberSlugOrSource || m.source_id === memberSlugOrSource) ??
    dim.members.find((m) => m.name === memberSlugOrSource);
  if (!member) return [memberSlugOrSource];

  if (member.isLeaf) return [member.source_id];

  const out: string[] = [];
  const stack = dim.members.filter((m) => m.parentId === member.id);
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur.isLeaf) out.push(cur.source_id);
    else stack.push(...dim.members.filter((m) => m.parentId === cur.id));
  }
  return out.length > 0 ? out : [member.source_id];
}

function orEq(property: string, values: string[]): string {
  if (values.length === 0) return "";
  if (values.length === 1) return `${property} eq '${odataEscape(values[0])}'`;
  return `(${values.map((v) => `${property} eq '${odataEscape(v)}'`).join(" or ")})`;
}

export function buildFactFilter(
  query: FactQuery,
  contract: SacModelContract,
  meta: PlanningModelMetadata,
): string | undefined {
  if (query.odataFilterRaw) return query.odataFilterRaw;

  const parts: string[] = [];

  const versionDim =
    contract.dimensions.find((d) => d.semanticType === "version") ??
    contract.dimensions.find((d) => /version/i.test(d.propertyName));
  if (query.versionMemberId && versionDim) {
    const values = leafSourceIds(meta, versionDim.propertyName, query.versionMemberId);
    const clause = orEq(versionDim.propertyName, values);
    if (clause) parts.push(clause);
  }

  const timeDim =
    contract.dimensions.find((d) => d.semanticType === "time") ??
    contract.dimensions.find((d) => /time|date|period/i.test(d.propertyName));
  if (query.timeMemberIds?.length && timeDim) {
    const values = query.timeMemberIds.flatMap((id) => leafSourceIds(meta, timeDim.propertyName, id));
    const clause = orEq(timeDim.propertyName, [...new Set(values)]);
    if (clause) parts.push(clause);
  }

  if (query.filters) {
    for (const [dimKey, memberIds] of Object.entries(query.filters)) {
      if (!memberIds?.length) continue;
      const dim =
        contract.dimensions.find((d) => d.propertyName === dimKey) ??
        contract.dimensions.find((d) => slugMatch(d.propertyName, dimKey)) ??
        meta.dimensions.find((d) => d.id === dimKey || d.source_id === dimKey);
      const propertyName =
        dim && "propertyName" in dim
          ? (dim as { propertyName: string }).propertyName
          : dim && "source_id" in dim
            ? (dim as { source_id: string }).source_id
            : dimKey;
      const values = memberIds.flatMap((id) => leafSourceIds(meta, propertyName, id));
      const clause = orEq(propertyName, [...new Set(values)]);
      if (clause) parts.push(clause);
    }
  }

  return parts.length > 0 ? parts.join(" and ") : undefined;
}

function slugMatch(propertyName: string, key: string): boolean {
  return propertyName.toLowerCase().replace(/[^a-z0-9]+/g, "_") === key.toLowerCase();
}

export function buildFactDataUrl(
  providerRoot: string,
  query: FactQuery,
  contract: SacModelContract,
  meta: PlanningModelMetadata,
  pageSize: number,
): string {
  const selectCols = [
    ...contract.dimensionOrder,
    ...contract.measures.map((m) => m.sourceProperty),
  ];
  const params = new URLSearchParams();
  params.set("$top", String(pageSize));
  params.set("$select", selectCols.join(","));
  const filter = buildFactFilter(query, contract, meta);
  if (filter) params.set("$filter", filter);
  return `${providerRoot}/FactData?${params.toString()}`;
}
