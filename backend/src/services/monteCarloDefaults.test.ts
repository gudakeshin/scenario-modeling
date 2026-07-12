import test from "node:test";
import assert from "node:assert";
import { CompiledModel } from "./expression.js";
import { applySampled, buildAutoDistributions, type DistributionConfig } from "./monteCarloService.js";
import { mulberry32, lognormalRandom } from "./random.js";

test("MC auto: percent delta stddev is 5pp not 0.15×delta", () => {
  const model = new CompiledModel({
    model_version: "mc",
    time_horizon: { start: "2026-Q1", end: "2026-Q1", granularity: "quarterly" },
    variables: [
      { id: "revenue", name: "Revenue", formula: "1000", dependencies: [], tags: ["input"], metric_type: "currency" },
      { id: "ni", name: "NI", formula: "revenue", dependencies: ["revenue"], tags: ["pl_metric"] },
    ],
  });
  const dists = buildAutoDistributions(
    [{ mapped_variable_id: "revenue", scenario_value: 1, delta_type: "percent" }],
    model,
  );
  assert.strictEqual(dists[0].stddev, 5);
  assert.notStrictEqual(dists[0].stddev, 0.15);
});

test("MC applySampled: clamped currency never negative", () => {
  const absVals: Record<string, number> = {};
  const notices: string[] = [];
  const clamps = new Map<string, number>();
  const inputById = new Map([
    ["revenue", { id: "revenue", name: "Revenue", base: 1000, metricType: "currency" as const }],
  ]);
  const dist: DistributionConfig = {
    variable_id: "revenue",
    type: "normal",
    base_value: -50,
    delta_type: "absolute",
    truncate_at_zero: true,
  };
  applySampled(absVals, dist, -50, new Map([["revenue", 1000]]), notices, inputById, clamps);
  assert.strictEqual(absVals.revenue, 0);
  assert.strictEqual(clamps.get("revenue"), 1);
});

test("MC lognormal default: all-positive over 2000 seeded iterations", () => {
  const model = new CompiledModel({
    model_version: "mc2",
    time_horizon: { start: "2026-Q1", end: "2026-Q1", granularity: "quarterly" },
    variables: [
      { id: "revenue", name: "Revenue", formula: "10000", dependencies: [], tags: ["input"], metric_type: "currency" },
      { id: "ni", name: "NI", formula: "revenue", dependencies: ["revenue"], tags: ["pl_metric"] },
    ],
  });
  const dists = buildAutoDistributions(
    [{ mapped_variable_id: "revenue", scenario_value: 10000, delta_type: "absolute" }],
    model,
  );
  assert.strictEqual(dists[0].type, "lognormal");
  const rng = mulberry32(42);
  for (let i = 0; i < 2000; i++) {
    const v = lognormalRandom(rng, dists[0].base_value, dists[0].stddev!);
    assert.ok(v > 0, `negative/zero at iter ${i}: ${v}`);
  }
});
