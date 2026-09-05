import test from "node:test";
import assert from "node:assert";
import { CompiledModel } from "./expression.js";
import { computeTornado, computeTwoWayGrid } from "./sensitivityService.js";

test("sensitivity: percent input 25 with swing 20 → 20/30 pp", () => {
  const model = new CompiledModel({
    model_version: "s",
    time_horizon: { start: "2026-Q1", end: "2026-Q1", granularity: "quarterly" },
    variables: [
      { id: "revenue", name: "Revenue", formula: "1000", dependencies: [], tags: ["input"], metric_type: "currency" },
      { id: "tax_rate", name: "Tax Rate", formula: "25", dependencies: [], tags: ["input"], metric_type: "percent" },
      {
        id: "tax",
        name: "Tax",
        formula: "revenue * tax_rate / 100",
        dependencies: ["revenue", "tax_rate"],
        tags: ["pl_metric"],
      },
    ],
  });
  const { bars } = computeTornado(model, {}, "tax", { swingPct: 20 });
  const rateBar = bars.find((b) => b.variable_id === "tax_rate")!;
  assert.strictEqual(rateBar.swing_unit, "pp");
  assert.strictEqual(rateBar.step_size, 5);
  // tax at 20% = 200, at 30% = 300
  assert.strictEqual(rateBar.low_value, 200);
  assert.strictEqual(rateBar.high_value, 300);
});

test("sensitivity: zero-base input gets metric-scaled step", () => {
  const model = new CompiledModel({
    model_version: "s0",
    time_horizon: { start: "2026-Q1", end: "2026-Q1", granularity: "quarterly" },
    variables: [
      { id: "other_income", name: "Other", formula: "0", dependencies: [], tags: ["input"], metric_type: "currency" },
      { id: "revenue", name: "Revenue", formula: "10000", dependencies: [], tags: ["input"], metric_type: "currency" },
      {
        id: "total",
        name: "Total",
        formula: "revenue + other_income",
        dependencies: ["revenue", "other_income"],
        tags: ["pl_metric"],
      },
    ],
  });
  const { bars, base_metric_value } = computeTornado(model, {}, "total", { swingPct: 20 });
  const bar = bars.find((b) => b.variable_id === "other_income")!;
  assert.strictEqual(bar.absolute_step, true);
  assert.strictEqual(bar.swing_unit, "absolute");
  const expectedStep = Math.max(Math.abs(base_metric_value) * 0.01, 1);
  assert.strictEqual(bar.step_size, expectedStep);
});

test("sensitivity: custom swingByVariable overrides default relative swing", () => {
  const model = new CompiledModel({
    model_version: "s-swing",
    time_horizon: { start: "2026-Q1", end: "2026-Q1", granularity: "quarterly" },
    variables: [
      { id: "revenue", name: "Revenue", formula: "1000", dependencies: [], tags: ["input"], metric_type: "currency" },
      { id: "cogs", name: "COGS", formula: "400", dependencies: [], tags: ["input"], metric_type: "currency" },
      {
        id: "net_income",
        name: "NI",
        formula: "revenue - cogs",
        dependencies: ["revenue", "cogs"],
        tags: ["pl_metric"],
      },
    ],
  });
  const defaultTornado = computeTornado(model, {}, "net_income", { swingPct: 20 });
  const custom = computeTornado(model, {}, "net_income", {
    swingPct: 20,
    swingByVariable: { revenue: 0.05 },
  });
  const defBar = defaultTornado.bars.find((b) => b.variable_id === "revenue")!;
  const custBar = custom.bars.find((b) => b.variable_id === "revenue")!;
  assert.ok(custBar.spread < defBar.spread, "±5% swing should be narrower than ±20%");
});

test("sensitivity: two-way grid has expected shape", () => {
  const model = new CompiledModel({
    model_version: "s2w",
    time_horizon: { start: "2026-Q1", end: "2026-Q1", granularity: "quarterly" },
    variables: [
      { id: "revenue", name: "Revenue", formula: "1000", dependencies: [], tags: ["input"], metric_type: "currency" },
      { id: "cogs", name: "COGS", formula: "400", dependencies: [], tags: ["input"], metric_type: "currency" },
      {
        id: "net_income",
        name: "NI",
        formula: "revenue - cogs",
        dependencies: ["revenue", "cogs"],
        tags: ["pl_metric"],
      },
    ],
  });
  const grid = computeTwoWayGrid(model, {}, "net_income", "revenue", "cogs", {
    swings: [-0.1, 0, 0.1],
  });
  assert.strictEqual(grid.grid.length, 3);
  assert.strictEqual(grid.grid[0].length, 3);
  // center cell ≈ 600
  assert.ok(Math.abs(grid.grid[1][1] - 600) < 1);
});

test("sensitivity: two-way respects per-variable MC-style swing arrays", () => {
  const model = new CompiledModel({
    model_version: "s2w-mc",
    time_horizon: { start: "2026-Q1", end: "2026-Q1", granularity: "quarterly" },
    variables: [
      { id: "revenue", name: "Revenue", formula: "1000", dependencies: [], tags: ["input"], metric_type: "currency" },
      { id: "cogs", name: "COGS", formula: "400", dependencies: [], tags: ["input"], metric_type: "currency" },
      {
        id: "net_income",
        name: "NI",
        formula: "revenue - cogs",
        dependencies: ["revenue", "cogs"],
        tags: ["pl_metric"],
      },
    ],
  });
  const narrow = computeTwoWayGrid(model, {}, "net_income", "revenue", "cogs", {
    swingByVariable: {
      revenue: [-0.05, 0, 0.05],
      cogs: [-0.05, 0, 0.05],
    },
  });
  const wide = computeTwoWayGrid(model, {}, "net_income", "revenue", "cogs", {
    swings: [-0.2, 0, 0.2],
  });
  // Corner of narrow grid should be closer to base than wide grid corner
  const base = 600;
  const narrowCorner = Math.abs(narrow.grid[0][0] - base);
  const wideCorner = Math.abs(wide.grid[0][0] - base);
  assert.ok(narrowCorner < wideCorner, "MC-narrow swings should produce smaller corner deltas");
});
