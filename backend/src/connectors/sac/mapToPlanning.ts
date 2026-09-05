/**
 * Map SacModelContract + dimensions → PlanningModelMetadata.
 */

import type { PlanningMeasure, PlanningModelMetadata } from "../types.js";
import { measureSlug, type SacModelContract } from "./csdlParser.js";
import type { PlanningDimension } from "../types.js";

export function mapContractToMetadata(
  contract: SacModelContract,
  dimensions: PlanningDimension[],
  opts?: {
    modelName?: string;
    providerRaw?: unknown;
    source_aggregates?: PlanningModelMetadata["source_aggregates"];
  },
): PlanningModelMetadata {
  // Preserve CSDL key order
  const ordered = contract.dimensionOrder
    .map((prop) => dimensions.find((d) => d.source_id === prop || d.id === prop || d.name === prop))
    .filter((d): d is PlanningDimension => !!d);

  const measures: PlanningMeasure[] = contract.measures.map((m) => ({
    id: measureSlug(m.sourceProperty),
    source_id: m.sourceProperty,
    name: m.sourceProperty,
    aggregation: m.aggregation ?? "sum",
    attributes: m.isSignedData ? { signed_data: true } : undefined,
  }));

  return {
    modelId: contract.providerId,
    modelName: opts?.modelName ?? contract.providerId,
    dimensions: ordered.length > 0 ? ordered : dimensions,
    measures,
    source_aggregates: opts?.source_aggregates,
    providerRaw: opts?.providerRaw ?? {
      csdlHash: contract.rawCsdlHash,
      dimensionOrder: contract.dimensionOrder,
      factEntityName: contract.factEntityName,
    },
  };
}
