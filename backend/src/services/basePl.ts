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
  scenarioId?: string,
): Promise<Record<string, number>> {
  const fromOutput = basePlFromOutput(rawPl);
  if (fromOutput) return fromOutput;
  if (!model) return {};

  // Dimensional (Anaplan) models: computeBaseCase's fallback evaluates without
  // loaded facts, so every fact-backed leaf reads as 0. Go through the scenario
  // resolver instead, which loads the pinned snapshot's live cell values.
  if (scenarioId) {
    try {
      const { isDimensionalModelDefinition } = await import("../models/dimensions.js");
      if (isDimensionalModelDefinition(model)) {
        const { getEvaluableModelForScenario } = await import("./modelResolver.js");
        const { DimensionalModel } = await import("./dimensionalModel.js");
        const resolved = await getEvaluableModelForScenario(scenarioId);
        if (resolved.source === "external_model" && resolved.model instanceof DimensionalModel) {
          return resolved.model.baseValues();
        }
      }
    } catch {
      // fall through to advisory fallback below
    }
  }

  return computeBaseCase(model);
}
