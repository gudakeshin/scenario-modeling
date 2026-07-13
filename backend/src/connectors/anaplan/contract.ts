import type { DimensionType, PlanningMeasure } from "../types.js";
import { slugId } from "../slug.js";

export const COMPOSITE_ID_SEPARATOR = "::";

export function normalizeAnaplanBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

export function modelApiRoot(baseUrl: string, modelId: string): string {
  return `${normalizeAnaplanBaseUrl(baseUrl)}/models/${encodeURIComponent(modelId)}`;
}

export function encodeCompositeModelId(modelId: string, moduleId: string): string {
  if (!modelId || !moduleId || modelId.includes(COMPOSITE_ID_SEPARATOR) || moduleId.includes(COMPOSITE_ID_SEPARATOR)) {
    throw new Error("Invalid Anaplan model or module id");
  }
  return `${modelId}${COMPOSITE_ID_SEPARATOR}${moduleId}`;
}

export function parseCompositeModelId(value: string): { modelId: string; moduleId: string } {
  const parts = value.split(COMPOSITE_ID_SEPARATOR);
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid Anaplan composite model id: ${value}`);
  }
  return { modelId: parts[0], moduleId: parts[1] };
}

export function inferAnaplanDimensionType(name: string): DimensionType {
  if (/^time$/i.test(name.trim())) return "time";
  if (/^versions?$/i.test(name.trim())) return "version";
  if (/account|p&l|\bgl\b/i.test(name)) return "account";
  return "generic";
}

export function mapAnaplanSummary(summary: unknown): NonNullable<PlanningMeasure["aggregation"]> {
  const value = String(summary ?? "").trim().toLowerCase();
  if (value.includes("average")) return "avg";
  if (value.includes("closing")) return "last";
  return "sum";
}

/**
 * Translate only plain arithmetic formulas whose references are all sibling
 * line items. Anaplan functions and cross-module syntax are intentionally
 * retained only as source metadata.
 */
export function safeArithmeticFormula(
  rawFormula: unknown,
  siblingMeasures: Array<{ id: string; name: string; sourceId?: string }>,
): string | undefined {
  let formula = String(rawFormula ?? "").trim();
  if (!formula) return undefined;

  const aliases = siblingMeasures
    .flatMap((measure) => [
      { alias: measure.name, id: measure.id },
      ...(measure.sourceId ? [{ alias: measure.sourceId, id: measure.id }] : []),
    ])
    .filter(({ alias }) => alias.trim())
    .sort((a, b) => b.alias.length - a.alias.length);

  for (const { alias, id } of aliases) {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    formula = formula.replace(new RegExp(`(?<![\\w])${escaped}(?![\\w])`, "gi"), id);
  }
  if (!/^[\w\s+\-*/().]+$/.test(formula)) return undefined;

  const ids = new Set(siblingMeasures.map((measure) => measure.id));
  const identifiers = formula.match(/[A-Za-z_]\w*/g) ?? [];
  if (identifiers.some((identifier) => !ids.has(slugId(identifier)))) return undefined;
  return formula;
}

export interface AnaplanColumnMaps {
  dimensionAliases: Record<string, string>;
  measureAliases: Record<string, string>;
}
