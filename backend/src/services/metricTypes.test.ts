import test from "node:test";
import assert from "node:assert";
import { inferMetricTypeFromId, resolveMetricType, pickDefaultTargetMetric } from "./metricTypes.js";
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

test("pickDefaultTargetMetric: prefers ebitda when net_income missing", () => {
  const available = [
    "gross_revenue",
    "net_revenue",
    "material_vehicle_cost",
    "gross_profit",
    "ebitda",
    "ebitda_margin",
  ];
  assert.strictEqual(pickDefaultTargetMetric(available, "net_income"), "ebitda");
  assert.strictEqual(pickDefaultTargetMetric(available), "ebitda");
  assert.strictEqual(pickDefaultTargetMetric(available, "gross_profit"), "gross_profit");
});

test("pickDefaultTargetMetric: skips margins when falling back", () => {
  assert.strictEqual(pickDefaultTargetMetric(["ebitda_margin", "total_opex"]), "total_opex");
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
