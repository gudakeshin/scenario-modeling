/**
 * Mapping pipeline unit tests — fixture → definition (signage, provenance, time, cross-foot).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  mapMetadataToDefinition,
  crossFootDimensional,
} from "./externalModelMapping.js";
import { factsToLeafMap } from "./dimensionalModel.js";
import type { PlanningModelMetadata } from "../connectors/types.js";

const fixture = JSON.parse(
  readFileSync(join(process.cwd(), "src/tests/fixtures/sac_snapshot_small.json"), "utf8"),
) as PlanningModelMetadata & {
  facts: Array<{ measureId: string; memberKey: string; value: number }>;
};

test("mapMetadataToDefinition preserves source signage and extracted provenance", () => {
  const def = mapMetadataToDefinition(fixture);
  assert.equal(def.model_kind, "dimensional");
  const account = def.dimensions.find((d) => d.id === "account");
  assert.ok(account);
  const cogs = account!.members.find((m) => m.id === "cogs");
  assert.equal(cogs?.sign, -1);
  const revenue = account!.members.find((m) => m.id === "revenue");
  assert.equal(revenue?.sign, 1);

  const amount = def.variables.find((v) => v.id === "amount");
  assert.ok(amount);
  assert.equal(amount!.provenance, "extracted");
  assert.equal(amount!.aggregation, "signed_sum");
  assert.ok(amount!.dependencies.length === 0);
});

test("time horizon inferred from time dimension leaves", () => {
  const def = mapMetadataToDefinition(fixture);
  assert.equal(def.time_dimension_id, "time");
  assert.ok(def.time_horizon.start.includes("2024"));
  assert.equal(def.time_horizon.granularity, "monthly");
});

test("crossFootDimensional emits warnings when source aggregates disagree", () => {
  const def = mapMetadataToDefinition(fixture);
  const leafFacts = factsToLeafMap(
    fixture.facts.map((f) => ({
      measure_id: f.measureId,
      member_key: f.memberKey,
      value: f.value,
    })),
  );
  // Force a mismatched aggregate
  const warnings = crossFootDimensional(def, leafFacts, [
    { measure_id: "amount", member_key: "world|all_products|revenue|fy2024|actual", value: 1 },
  ]);
  assert.ok(warnings.length >= 1);
});
