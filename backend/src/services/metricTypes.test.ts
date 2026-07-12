import test from "node:test";
import assert from "node:assert";
import { inferMetricTypeFromId, resolveMetricType } from "./metricTypes.js";
import { CompiledModel } from "./expression.js";

test("inferMetricTypeFromId: percent/ratio/count/volume/currency", () => {
  assert.strictEqual(inferMetricTypeFromId("gross_margin"), "percent");
  assert.strictEqual(inferMetricTypeFromId("tax_rate", "Tax Rate"), "percent");
  assert.strictEqual(inferMetricTypeFromId("growth_pct"), "percent");
  assert.strictEqual(inferMetricTypeFromId("debt_turnover"), "ratio");
  assert.strictEqual(inferMetricTypeFromId("headcount"), "count");
  assert.strictEqual(inferMetricTypeFromId("fte_count"), "count");
  assert.strictEqual(inferMetricTypeFromId("store_count", "Stores"), "count");
  assert.strictEqual(inferMetricTypeFromId("units_sold"), "volume");
  assert.strictEqual(inferMetricTypeFromId("revenue"), "currency");
  assert.strictEqual(inferMetricTypeFromId("net_income"), "currency");
});

test("CompiledModel exposes metricType on inputs", () => {
  const model = new CompiledModel({
    model_version: "t",
    time_horizon: { start: "2026-Q1", end: "2026-Q4", granularity: "quarterly" },
    variables: [
      { id: "revenue", name: "Revenue", formula: "1000", dependencies: [], tags: ["input"], metric_type: "currency" },
      { id: "gross_margin", name: "GM%", formula: "40", dependencies: [], tags: ["input"], metric_type: "percent" },
      { id: "legacy_rate", name: "Legacy Rate", formula: "5", dependencies: [], tags: ["input"] },
    ],
  });
  const byId = Object.fromEntries(model.inputs.map((i) => [i.id, i]));
  assert.strictEqual(byId.revenue.metricType, "currency");
  assert.strictEqual(byId.gross_margin.metricType, "percent");
  assert.strictEqual(byId.legacy_rate.metricType, "percent"); // inferred from id
  assert.strictEqual(resolveMetricType(undefined, "cogs"), "currency");
});
