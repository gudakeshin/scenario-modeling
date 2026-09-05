/**
 * SAC master-data fetch: pagination, hierarchy, account signage.
 */

import type { PlanningDimension, PlanningMember } from "../types.js";
import { accountSign, slugId } from "./contract.js";
import type { SacDimensionContract, SacModelContract } from "./csdlParser.js";
import type { ODataClient } from "./odataClient.js";

function pick(row: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) {
    if (row[k] != null && row[k] !== "") return row[k];
    const hit = Object.entries(row).find(([key]) => key.toLowerCase() === k.toLowerCase());
    if (hit && hit[1] != null && hit[1] !== "") return hit[1];
  }
  return undefined;
}

export async function fetchAllMembers(
  client: ODataClient,
  providerRoot: string,
  dim: SacDimensionContract,
): Promise<PlanningMember[]> {
  const endpoints =
    dim.masterEndpoint === "MasterWithHierarchy"
      ? [`${dim.propertyName}MasterWithHierarchy`, `${dim.propertyName}Master`, "MasterData"]
      : dim.masterEndpoint === "Master"
        ? [`${dim.propertyName}Master`, `${dim.propertyName}MasterWithHierarchy`, "MasterData"]
        : ["MasterData", `${dim.propertyName}Master`, `${dim.propertyName}MasterWithHierarchy`];

  let rows: Array<Record<string, unknown>> = [];
  let lastErr: Error | null = null;

  for (const ep of endpoints) {
    try {
      const start = `${providerRoot}/${encodeURIComponent(ep)}?$top=${client.defaultPageSize}`;
      rows = [];
      for await (const page of client.paginateJson(start)) {
        for (const row of page.value) {
          if (row && typeof row === "object") rows.push(row as Record<string, unknown>);
        }
      }
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e as Error;
      rows = [];
    }
  }

  if (lastErr && rows.length === 0) {
    // Empty dimension is allowed; caller may warn.
    return [];
  }

  const members: PlanningMember[] = rows.map((row, i) => {
    const sourceId = String(pick(row, "ID", "Id", "id", "MemberId", "memberId") ?? `m${i}`);
    const name = String(pick(row, "Description", "Name", "name", "Text") ?? sourceId);
    const parentRaw = pick(row, "ParentId", "parentId", "Parent", "PARENT_ID");
    const parentId =
      parentRaw != null && String(parentRaw) !== "" ? slugId(String(parentRaw)) : null;
    const ordinalRaw = pick(row, "OrderId", "Ordinal", "ordinal", "PreviousId");
    const ordinal = Number.isFinite(Number(ordinalRaw)) ? Number(ordinalRaw) : i;
    const sign =
      dim.semanticType === "account"
        ? accountSign(pick(row, "AccountType", "accountType", "ACC_TYPE"))
        : 1;
    return {
      id: slugId(sourceId),
      source_id: sourceId,
      name,
      parentId,
      isLeaf: true,
      sign,
      attributes: row,
      ordinal,
    };
  });

  for (const m of members) {
    m.isLeaf = !members.some((c) => c.parentId === m.id);
  }
  return members;
}

export async function loadDimensions(
  client: ODataClient,
  providerRoot: string,
  contract: SacModelContract,
): Promise<PlanningDimension[]> {
  const dims: PlanningDimension[] = [];
  for (const d of contract.dimensions) {
    const members = await fetchAllMembers(client, providerRoot, d);
    dims.push({
      id: slugId(d.propertyName),
      source_id: d.propertyName,
      name: d.propertyName,
      type: d.semanticType,
      members,
      hierarchies: [
        {
          id: "default",
          name: "Default",
          rootMemberIds: members.filter((m) => !m.parentId).map((m) => m.id),
        },
      ],
      defaultHierarchyId: "default",
    });
  }
  return dims;
}
