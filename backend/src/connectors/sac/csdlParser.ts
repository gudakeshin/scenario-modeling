/**
 * Deterministic CSDL ($metadata) parser for SAC Data Export Service.
 */

import { XMLParser } from "fast-xml-parser";
import { createHash } from "node:crypto";
import { inferDimensionType, slugId } from "./contract.js";

export interface SacProperty {
  name: string;
  type?: string;
  isKey?: boolean;
}

export interface SacDimensionContract {
  entitySetName: string;
  propertyName: string;
  masterEndpoint: "MasterWithHierarchy" | "Master" | "MasterData";
  semanticType: "account" | "time" | "version" | "generic";
}

export interface SacMeasureContract {
  sourceProperty: string;
  aggregation?: "sum" | "avg" | "last";
  isSignedData?: boolean;
}

export interface SacModelContract {
  providerId: string;
  factEntityName: string;
  properties: SacProperty[];
  keyProperties: string[];
  dimensions: SacDimensionContract[];
  measures: SacMeasureContract[];
  /** Stable FactData key / dimension order for member_key. */
  dimensionOrder: string[];
  rawCsdlHash: string;
}

function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function collectEntityTypes(root: Record<string, unknown>): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const schemas = asArray(
    (root["edmx:Edmx"] as Record<string, unknown> | undefined)?.["edmx:DataServices"]
      ? ((root["edmx:Edmx"] as Record<string, unknown>)["edmx:DataServices"] as Record<string, unknown>)["Schema"]
      : (root.Edmx as Record<string, unknown> | undefined)?.DataServices
        ? ((root.Edmx as Record<string, unknown>).DataServices as Record<string, unknown>).Schema
        : (root.Schema as unknown),
  ) as Array<Record<string, unknown>>;

  for (const schema of schemas) {
    for (const et of asArray<Record<string, unknown>>(
      schema.EntityType as Record<string, unknown> | Array<Record<string, unknown>>,
    )) {
      out.push(et);
    }
  }
  // Flat fallback when parser strips namespaces differently
  if (out.length === 0) {
    const walk = (node: unknown): void => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) {
        for (const n of node) walk(n);
        return;
      }
      const obj = node as Record<string, unknown>;
      if (obj.EntityType) {
        for (const et of asArray<Record<string, unknown>>(
          obj.EntityType as Record<string, unknown> | Array<Record<string, unknown>>,
        )) out.push(et);
      }
      for (const v of Object.values(obj)) walk(v);
    };
    walk(root);
  }
  return out;
}

function collectEntitySets(root: Record<string, unknown>): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const n of node) walk(n);
      return;
    }
    const obj = node as Record<string, unknown>;
    if (obj.EntitySet) {
      for (const es of asArray<Record<string, unknown>>(
        obj.EntitySet as Record<string, unknown> | Array<Record<string, unknown>>,
      )) out.push(es);
    }
    for (const v of Object.values(obj)) walk(v);
  };
  walk(root);
  return out;
}

function propName(p: Record<string, unknown>): string {
  return String(p.Name ?? p.name ?? "");
}

function isNumericType(t: string | undefined): boolean {
  if (!t) return false;
  return /Decimal|Double|Single|Int|Byte|Float|Number/i.test(t);
}

function isMeasureProperty(name: string, type?: string): boolean {
  if (/signeddata|measure|amount|value|quantity/i.test(name)) return true;
  return isNumericType(type) && !/id|date|time|version|account|region|product/i.test(name);
}

export function parseCsdl(xml: string, providerId: string): SacModelContract {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
    removeNSPrefix: true,
  });
  const root = parser.parse(xml) as Record<string, unknown>;
  const entityTypes = collectEntityTypes(root);
  const entitySets = collectEntitySets(root);

  const factEt =
    entityTypes.find((et) => /factdata/i.test(String(et.Name ?? ""))) ??
    entityTypes.find((et) => /fact/i.test(String(et.Name ?? "")));

  if (!factEt) {
    throw new Error(`SAC $metadata for '${providerId}' has no FactData EntityType`);
  }

  const props = asArray<Record<string, unknown>>(
    factEt.Property as Record<string, unknown> | Array<Record<string, unknown>>,
  ).map((p) => ({
    name: propName(p),
    type: p.Type ? String(p.Type) : undefined,
  }));

  const keyRefs = asArray(
    (factEt.Key as Record<string, unknown> | undefined)?.PropertyRef as
      | Record<string, unknown>
      | Array<Record<string, unknown>>,
  ).map((k) => String(k.Name ?? k.name ?? ""));

  const keyProperties = (keyRefs.length > 0 ? keyRefs : props.map((p) => p.name)).filter(
    (n) => n && !isMeasureProperty(n),
  );

  const measures: SacModelContract["measures"] = [];
  for (const p of props) {
    if (!p.name) continue;
    if (keyProperties.includes(p.name)) continue;
    if (!isMeasureProperty(p.name, p.type)) continue;
    measures.push({
      sourceProperty: p.name,
      aggregation: "sum",
      isSignedData: /signeddata/i.test(p.name),
    });
  }
  if (measures.length === 0) {
    measures.push({ sourceProperty: "SignedData", aggregation: "sum", isSignedData: true });
  }

  const setNames = entitySets.map((es) => String(es.Name ?? ""));
  const dimensions: SacModelContract["dimensions"] = [];
  for (const key of keyProperties) {
    const masterWithHier = setNames.find((n) => new RegExp(`^${key}MasterWithHierarchy$`, "i").test(n));
    const master = setNames.find((n) => new RegExp(`^${key}Master$`, "i").test(n));
    const masterData = setNames.find((n) => /MasterData/i.test(n));
    dimensions.push({
      entitySetName: masterWithHier ?? master ?? key,
      propertyName: key,
      masterEndpoint: masterWithHier
        ? "MasterWithHierarchy"
        : master
          ? "Master"
          : masterData
            ? "MasterData"
            : "Master",
      semanticType: inferDimensionType(key),
    });
  }

  return {
    providerId,
    factEntityName: String(factEt.Name ?? "FactData"),
    properties: props.map((p) => ({
      ...p,
      isKey: keyProperties.includes(p.name),
    })),
    keyProperties,
    dimensions,
    measures,
    dimensionOrder: dimensions.map((d) => d.propertyName),
    rawCsdlHash: createHash("sha256").update(xml).digest("hex"),
  };
}

export function measureSlug(sourceProperty: string): string {
  return slugId(sourceProperty);
}
