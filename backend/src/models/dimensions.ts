/**
 * Dimensional model types — native multidimensional planning engine.
 */

import type { MetricType, VariableProvenance } from "../services/metricTypes.js";
import type { TimeHorizon } from "./registry.js";

export type DimensionType = "generic" | "account" | "time" | "version";

export type AggregationKind = "sum" | "signed_sum" | "avg" | "last";

export interface Member {
  id: string;
  name: string;
  parentId: string | null;
  isLeaf: boolean;
  /** Account signage (+1 / -1); non-account dims use 1. */
  sign: 1 | -1;
  attributes?: Record<string, unknown>;
  ordinal: number;
}

export interface Dimension {
  id: string;
  name: string;
  type: DimensionType;
  members: Member[];
  defaultHierarchyId?: string;
}

export interface DimensionalVariable {
  id: string;
  name: string;
  /** Ordered dimension ids this variable is defined on; [] = scalar. */
  dims: string[];
  formula?: string;
  dependencies: string[];
  aggregation: AggregationKind;
  tags?: string[];
  metric_type?: MetricType;
  provenance?: VariableProvenance;
}

export interface DimensionalModelDefinition {
  model_kind: "dimensional";
  model_version: string;
  dimensions: Dimension[];
  variables: DimensionalVariable[];
  time_dimension_id?: string;
  time_horizon: TimeHorizon;
  build_warnings?: string[];
}

/** '|' joined leaf member ids in the variable's dim order. */
export type CellKey = string;

export const CELL_SEP = "|";

export function makeCellKey(parts: string[]): CellKey {
  return parts.join(CELL_SEP);
}

export function splitCellKey(key: CellKey): string[] {
  if (key === "") return [];
  return key.split(CELL_SEP);
}

export interface DimensionalOverride {
  variableId: string;
  /** dimId → memberId; missing dims broadcast; non-leaf applies to leaf subtree. */
  memberScope?: Record<string, string>;
  value: number;
  delta_type: "percent" | "absolute" | "additive";
}

export interface DimensionalEvalResult {
  totals: Record<string, number>;
  valueAt(variableId: string, pov: Record<string, string>): number | undefined;
}

/** Type guard for stored model_definition JSON. */
export function isDimensionalModelDefinition(
  def: unknown,
): def is DimensionalModelDefinition {
  return (
    !!def &&
    typeof def === "object" &&
    (def as DimensionalModelDefinition).model_kind === "dimensional"
  );
}
