import type {
  PlanningDimension,
  PlanningMeasure,
  PlanningModelMetadata,
} from "../types.js";
import { slugId } from "../slug.js";
import type { AnaplanClient } from "./client.js";
import {
  type AnaplanColumnMaps,
  inferAnaplanDimensionType,
  mapAnaplanSummary,
  safeArithmeticFormula,
} from "./contract.js";
import { arrayFromBody, fetchListDimension, fetchViewDimension } from "./items.js";

export interface ModuleMetadataOptions {
  modelId: string;
  moduleId: string;
  modelName: string;
  moduleName: string;
}

export interface BuiltModuleMetadata {
  meta: PlanningModelMetadata;
  columnMaps: AnaplanColumnMaps;
}

interface DimensionRef {
  id: string;
  name: string;
  kind: "time" | "version" | "list";
}

function pick(record: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] != null && record[key] !== "") return record[key];
    const match = Object.entries(record).find(([candidate]) => candidate.toLowerCase() === key.toLowerCase());
    if (match && match[1] != null && match[1] !== "") return match[1];
  }
  return undefined;
}

function refFromUnknown(value: unknown, fallbackName: string): { id: string; name: string } | null {
  if (value == null || value === "" || value === false) return null;
  if (value === true) return { id: fallbackName, name: fallbackName };
  if (typeof value === "string" || typeof value === "number") {
    const text = String(value).trim();
    if (!text || /^(none|not applicable)$/i.test(text)) return null;
    return { id: text, name: fallbackName === "List" ? text : fallbackName };
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const id = String(pick(record, "id", "dimensionId", "listId", "name") ?? "").trim();
    const name = String(pick(record, "name", "displayName") ?? fallbackName).trim();
    return id ? { id, name: name || fallbackName } : null;
  }
  return null;
}

function refsFromAppliesTo(value: unknown): Array<{ id: string; name: string }> {
  if (Array.isArray(value)) {
    return value.map((entry) => refFromUnknown(entry, "List")).filter((entry): entry is { id: string; name: string } => !!entry);
  }
  if (typeof value === "string") {
    return value.split(",").map((part) => refFromUnknown(part.trim(), "List")).filter((entry): entry is { id: string; name: string } => !!entry);
  }
  const single = refFromUnknown(value, "List");
  return single ? [single] : [];
}

function numericLineItem(lineItem: Record<string, unknown>): boolean {
  const format = pick(lineItem, "format", "dataType", "formatType");
  if (format && typeof format === "object") {
    const kind = pick(format as Record<string, unknown>, "dataType", "type", "formatType");
    return !kind || /number|numeric|currency|percentage/i.test(String(kind));
  }
  return !format || /number|numeric|currency|percentage/i.test(String(format));
}

function currencyUnit(lineItem: Record<string, unknown>): string | undefined {
  const format = pick(lineItem, "format");
  if (!format || typeof format !== "object") return undefined;
  const value = pick(format as Record<string, unknown>, "currencyCode", "currencySymbol", "currency");
  return value != null && String(value).trim() ? String(value).trim() : undefined;
}

function uniqueMeasureIds(lineItems: Array<Record<string, unknown>>): string[] {
  const seen = new Map<string, number>();
  return lineItems.map((item) => {
    const base = slugId(String(pick(item, "name", "id") ?? "measure"));
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}_${count + 1}`;
  });
}

function addAlias(target: Record<string, string>, alias: unknown, id: string): void {
  const normalized = String(alias ?? "").trim().toLowerCase();
  if (normalized) target[normalized] = id;
}

function viewDimensionRefs(body: unknown): Array<{ id: string; name: string }> {
  const found: Array<{ id: string; name: string }> = [];
  const visit = (value: unknown, key = ""): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key);
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    const id = pick(record, "id", "dimensionId");
    const name = pick(record, "name", "dimensionName");
    if (
      id != null
      && name != null
      && (/dimension|pages|rows|columns/i.test(key) || record.dimensionId != null)
      && !/line items?/i.test(String(name))
    ) {
      found.push({ id: String(id), name: String(name) });
    }
    for (const [childKey, child] of Object.entries(record)) visit(child, childKey);
  };
  visit(body);
  return [...new Map(found.map((ref) => [ref.id, ref])).values()];
}

export async function buildModuleMetadata(
  client: AnaplanClient,
  modelRoot: string,
  options: ModuleMetadataOptions,
): Promise<BuiltModuleMetadata> {
  const [lineItemsBody, viewBody] = await Promise.all([
    client.fetchJson(
      `${modelRoot}/modules/${encodeURIComponent(options.moduleId)}/lineItems?includeAll=true`,
    ),
    client.fetchJson(`${modelRoot}/views/${encodeURIComponent(options.moduleId)}`),
  ]);
  const viewRefs = viewDimensionRefs(viewBody);
  const allLineItems = arrayFromBody(lineItemsBody, "items", "lineItems");
  const lineItems = allLineItems.filter(numericLineItem);
  if (lineItems.length === 0) {
    throw new Error(`Anaplan module ${options.moduleName} has no numeric line items`);
  }

  const ids = uniqueMeasureIds(lineItems);
  const siblings = lineItems.map((item, index) => ({
    id: ids[index],
    name: String(pick(item, "name", "id") ?? ids[index]),
    sourceId: String(pick(item, "id") ?? ids[index]),
  }));
  const measures: PlanningMeasure[] = lineItems.map((item, index) => {
    const rawFormula = pick(item, "formula");
    const formula = safeArithmeticFormula(rawFormula, siblings);
    return {
      id: ids[index],
      source_id: String(pick(item, "id", "name") ?? ids[index]),
      name: String(pick(item, "name", "id") ?? ids[index]),
      aggregation: mapAnaplanSummary(pick(item, "summary", "summaryMethod")),
      unit: currencyUnit(item),
      formula,
      attributes: {
        ...(rawFormula && !formula ? { source_formula: String(rawFormula) } : {}),
        anaplan: item,
      },
    };
  });

  const refs = new Map<string, DimensionRef>();
  for (const lineItem of lineItems) {
    const time = refFromUnknown(pick(lineItem, "timeScale", "time"), "Time");
    const viewTime = viewRefs.find((ref) => inferAnaplanDimensionType(ref.name) === "time");
    if (time) {
      const ref = viewTime ?? { id: "Time", name: "Time" };
      refs.set(`time:${ref.id}`, { ...ref, kind: "time" });
    }
    const version = refFromUnknown(pick(lineItem, "versions", "version"), "Versions");
    const viewVersion = viewRefs.find((ref) => inferAnaplanDimensionType(ref.name) === "version");
    if (version) {
      const ref = viewVersion ?? { id: "Versions", name: "Versions" };
      refs.set(`version:${ref.id}`, { ...ref, kind: "version" });
    }
    for (const list of refsFromAppliesTo(pick(lineItem, "appliesTo", "dimensions"))) {
      const viewRef = viewRefs.find((ref) => ref.id === list.id || ref.name === list.name);
      const ref = viewRef ?? list;
      refs.set(`list:${ref.id}`, { ...ref, kind: "list" });
    }
  }

  const orderedRefs = [...refs.values()].sort((left, right) => {
    const rank = (ref: DimensionRef) => ref.kind === "time" ? 0 : ref.kind === "version" ? 1 : 2;
    return rank(left) - rank(right) || left.id.localeCompare(right.id);
  });
  const dimensions: PlanningDimension[] = await Promise.all(orderedRefs.map(async (ref) => {
    const loaded = ref.kind === "list"
      ? await fetchListDimension(client, modelRoot, ref)
      : await fetchViewDimension(client, modelRoot, options.moduleId, ref.id, ref.name);
    loaded.type = inferAnaplanDimensionType(ref.kind === "version" ? "Versions" : ref.name);
    return loaded;
  }));

  const dimensionAliases: Record<string, string> = {};
  for (const dimension of dimensions) {
    addAlias(dimensionAliases, dimension.id, dimension.id);
    addAlias(dimensionAliases, dimension.source_id, dimension.id);
    addAlias(dimensionAliases, dimension.name, dimension.id);
  }
  const measureAliases: Record<string, string> = {};
  measures.forEach((measure) => {
    addAlias(measureAliases, measure.id, measure.id);
    addAlias(measureAliases, measure.source_id, measure.id);
    addAlias(measureAliases, measure.name, measure.id);
  });

  return {
    meta: {
      modelId: `${options.modelId}::${options.moduleId}`,
      modelName: `${options.modelName} · ${options.moduleName}`,
      dimensions,
      measures,
      providerRaw: {
        provider: "anaplan",
        modelId: options.modelId,
        moduleId: options.moduleId,
        lineItems: allLineItems,
        dimensionOrder: dimensions.map((dimension) => dimension.id),
      },
    },
    columnMaps: { dimensionAliases, measureAliases },
  };
}
