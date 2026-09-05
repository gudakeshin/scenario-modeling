import type { PlanningDimension, PlanningMember } from "../types.js";
import { slugId } from "../slug.js";
import type { AnaplanClient } from "./client.js";
import { inferAnaplanDimensionType } from "./contract.js";

export function arrayFromBody(body: unknown, ...keys: string[]): Array<Record<string, unknown>> {
  if (Array.isArray(body)) return body.filter((item): item is Record<string, unknown> => !!item && typeof item === "object");
  if (!body || typeof body !== "object") return [];
  const record = body as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) {
      return value.filter((item): item is Record<string, unknown> => !!item && typeof item === "object");
    }
  }
  return [];
}

function pick(row: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (row[key] != null && row[key] !== "") return row[key];
    const match = Object.entries(row).find(([candidate]) => candidate.toLowerCase() === key.toLowerCase());
    if (match && match[1] != null && match[1] !== "") return match[1];
  }
  return undefined;
}

function mapMembers(rows: Array<Record<string, unknown>>): PlanningMember[] {
  const members = rows.map((row, index): PlanningMember => {
    const sourceId = String(pick(row, "id", "itemId", "sourceId", "code", "name") ?? `item-${index}`);
    const name = String(pick(row, "name", "displayName", "code") ?? sourceId);
    const parentValue = pick(row, "parentId", "parent", "parentItemId");
    const explicitLeaf = pick(row, "isLeaf", "leaf");
    const ordinalValue = Number(pick(row, "ordinal", "index", "order"));
    return {
      id: slugId(sourceId),
      source_id: sourceId,
      name,
      parentId: parentValue != null && String(parentValue) !== ""
        ? slugId(typeof parentValue === "object"
          ? String((parentValue as Record<string, unknown>).id ?? "")
          : String(parentValue))
        : null,
      isLeaf: typeof explicitLeaf === "boolean" ? explicitLeaf : true,
      sign: 1,
      attributes: row,
      ordinal: Number.isFinite(ordinalValue) ? ordinalValue : index,
    };
  });

  for (const member of members) {
    if (members.some((candidate) => candidate.parentId === member.id)) member.isLeaf = false;
  }
  return members;
}

function dimension(
  sourceId: string,
  name: string,
  members: PlanningMember[],
): PlanningDimension {
  return {
    id: slugId(name || sourceId),
    source_id: sourceId,
    name: name || sourceId,
    type: inferAnaplanDimensionType(name || sourceId),
    members,
    hierarchies: [{
      id: "default",
      name: "Default",
      rootMemberIds: members.filter((member) => !member.parentId).map((member) => member.id),
    }],
    defaultHierarchyId: "default",
  };
}

export async function fetchListDimension(
  client: AnaplanClient,
  modelRoot: string,
  list: { id: string; name: string },
): Promise<PlanningDimension> {
  const body = await client.fetchJson(
    `${modelRoot}/lists/${encodeURIComponent(list.id)}/items?includeAll=true`,
  );
  return dimension(list.id, list.name, mapMembers(arrayFromBody(body, "listItems", "items")));
}

export async function fetchViewDimension(
  client: AnaplanClient,
  modelRoot: string,
  viewId: string,
  sourceId: string,
  name: string,
): Promise<PlanningDimension> {
  const body = await client.fetchJson(
    `${modelRoot}/views/${encodeURIComponent(viewId)}/dimensions/${encodeURIComponent(sourceId)}/items`,
  );
  return dimension(sourceId, name, mapMembers(arrayFromBody(body, "items", "dimensionItems")));
}
