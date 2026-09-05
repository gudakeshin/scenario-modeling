import test from "node:test";
import assert from "node:assert";
import { CompiledModel } from "./expression.js";
import { computeAttribution } from "./attributionService.js";

function linearModel() {
  return new CompiledModel({
    model_version: "attr-test",
    time_horizon: { start: "2026-Q1", end: "2026-Q1", granularity: "quarterly" },
    variables: [
      { id: "revenue", name: "Revenue", formula: "1000", dependencies: [], tags: ["input"], metric_type: "currency" },
      { id: "cogs", name: "COGS", formula: "400", dependencies: [], tags: ["input"], metric_type: "currency" },
      { id: "opex", name: "OpEx", formula: "200", dependencies: [], tags: ["input"], metric_type: "currency" },
      {
        id: "net_income",
        name: "Net Income",
        formula: "revenue - cogs - opex",
        dependencies: ["revenue", "cogs", "opex"],
        tags: ["pl_metric"],
      },
    ],
  });
}

test("attribution: contributions sum to total delta", () => {
  const model = linearModel();
  const baseAbs = { revenue: 1000, cogs: 400, opex: 200 };
  const scenarioAbs = { revenue: 1200, cogs: 450, opex: 200 };

  const result = computeAttribution(model, baseAbs, scenarioAbs, "net_income");

  // delta = (1200-450-200) - (1000-400-200) = 550 - 400 = 150
  assert.strictEqual(result.total_delta, 150);
  assert.strictEqual(result.method, "exact_shapley");

  const sum = result.bars.reduce((s, b) => s + b.contribution, 0);
  assert.ok(Math.abs(sum - result.total_delta) < 0.02, `sum ${sum} vs delta ${result.total_delta}`);

  const residual = result.bars.find((b) => b.residual);
  assert.ok(residual, "residual bar present");
});

test("attribution: zero change yields residual-only bars", () => {
  const model = linearModel();
  const baseAbs = { revenue: 1000, cogs: 400, opex: 200 };
  const result = computeAttribution(model, baseAbs, baseAbs, "net_income");
  assert.strictEqual(result.total_delta, 0);
  assert.strictEqual(result.bars.length, 1);
  assert.strictEqual(result.bars[0].residual, true);
});
