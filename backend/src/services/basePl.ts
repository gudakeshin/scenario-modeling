/**
 * Resolve base-case P&L for QA / BA / compare / export.
 * Prefer the persisted base_pl from the latest simulation output
 * (required for XLSX models where getModelDefinition returns null).
 */

import { computeBaseCase, type ModelDefinition } from "../models/registry.js";

export function basePlFromOutput(
  rawPl: Record<string, unknown> | null | undefined,
): Record<string, number> | null {
  if (!rawPl || typeof rawPl !== "object") return null;
  const bp = rawPl.base_pl;
  if (!bp || typeof bp !== "object") return null;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(bp as Record<string, unknown>)) {
    if (typeof v === "number" && Number.isFinite(v)) out[k] = Math.round(v * 100) / 100;
  }
  return Object.keys(out).length > 0 ? out : null;
}

export async function resolveBasePl(
  rawPl: Record<string, unknown> | null | undefined,
  model: ModelDefinition | null,
): Promise<Record<string, number>> {
  const fromOutput = basePlFromOutput(rawPl);
  if (fromOutput) return fromOutput;
  if (model) return computeBaseCase(model);
  return {};
}
