import test from "node:test";
import assert from "node:assert";
import { CompiledModel } from "./expression.js";
import { computeGoalSeek } from "./goalSeekService.js";

test("goalSeek: converges on linear fixture", () => {
  const model = new CompiledModel({
    model_version: "gs-test",
    time_horizon: { start: "2026-Q1", end: "2026-Q1", granularity: "quarterly" },
    variables: [
      { id: "revenue", name: "Revenue", formula: "1000", dependencies: [], tags: ["input"], metric_type: "currency" },
      { id: "cogs", name: "COGS", formula: "400", dependencies: [], tags: ["input"], metric_type: "currency" },
      {
        id: "net_income",
        name: "Net Income",
        formula: "revenue - cogs",
        dependencies: ["revenue", "cogs"],
        tags: ["pl_metric"],
      },
    ],
  });

  // net_income = revenue - 400; want net_income = 800 → revenue = 1200
  const result = computeGoalSeek(
    model,
    { revenue: 1000, cogs: 400 },
    {
      variableId: "revenue",
      targetMetric: "net_income",
      targetValue: 800,
      low: 500,
      high: 2000,
      tolerance: 0.01,
      maxIterations: 40,
    },
  );

  assert.ok(result.converged, `should converge: ${JSON.stringify(result.diagnostics)}`);
  assert.ok(result.solved_value != null);
  assert.ok(Math.abs(result.solved_value! - 1200) < 0.1, `solved ${result.solved_value}`);
  assert.ok(result.achieved_metric != null);
  assert.ok(Math.abs(result.achieved_metric! - 800) < 0.1);
  assert.ok(result.iterations > 0);
});

test("goalSeek: reports constraint violation", () => {
  const model = new CompiledModel({
    model_version: "gs-c",
    time_horizon: { start: "2026-Q1", end: "2026-Q1", granularity: "quarterly" },
    variables: [
      { id: "x", name: "X", formula: "10", dependencies: [], tags: ["input"], metric_type: "currency" },
      { id: "y", name: "Y", formula: "x * 2", dependencies: ["x"], tags: ["pl_metric"] },
    ],
  });

  const result = computeGoalSeek(
    model,
    { x: 10 },
    {
      variableId: "x",
      targetMetric: "y",
      targetValue: 40, // needs x=20
      low: 0,
      high: 50,
      constraints: [{ lever: "x", type: "ceiling", max: 15, reason: "cap" }],
    },
  );

  assert.strictEqual(result.converged, false);
  assert.ok(result.diagnostics.constraint_violations?.length);
});
