/**
 * Unit tests for connection error decoding and heuristic mapping preview.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { decodeConnectionError } from "../services/connectionService.js";
import { buildMappingPreview } from "../services/externalModelMapping.js";
import type { PlanningModelMetadata } from "../connectors/types.js";

test("decodeConnectionError maps auth failures", () => {
  assert.match(decodeConnectionError(new Error("HTTP 401 Unauthorized")), /Authentication failed/);
  assert.match(decodeConnectionError(new Error("invalid_client")), /Authentication failed/);
  assert.match(decodeConnectionError(new Error("ECONNREFUSED")), /Could not reach/);
});

test("buildMappingPreview classifies input vs derived without LLM", () => {
  const meta: PlanningModelMetadata = {
    modelId: "m1",
    modelName: "Demo",
    dimensions: [
      {
        id: "account",
        source_id: "Account",
        name: "Account",
        type: "account",
        hierarchies: [],
        members: [],
      },
    ],
    measures: [
      { id: "revenue", source_id: "Revenue", name: "Revenue" },
      { id: "gm", source_id: "GM", name: "Gross Margin %" },
      { id: "calc1", source_id: "Calc", name: "Calc Profit", formula: "revenue - cogs" },
    ],
  };
  const preview = buildMappingPreview(meta);
  assert.equal(preview.account_signage, true);
  const byId = Object.fromEntries(preview.measures.map((m) => [m.id, m]));
  assert.equal(byId.revenue.role, "input");
  assert.equal(byId.gm.role, "formula_derived_on_import");
  assert.equal(byId.calc1.role, "formula_exposed");
});
