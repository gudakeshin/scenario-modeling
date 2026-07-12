import test from "node:test";
import assert from "node:assert";
import { CompiledModel } from "./expression.js";
import { aggregatePeriodPl, aggregateXlsxPeriodPl, periodOverrides, hasPeriodGrowth } from "./simulationAggregation.js";
import type { ModelDefinition } from "../models/registry.js";

function makeModel(overrides?: Partial<ModelDefinition>): { model: CompiledModel; def: ModelDefinition } {
  const def: ModelDefinition = {
    model_version: "agg-test",
    time_horizon: { start: "2026-Q1", end: "2026-Q4", granularity: "quarterly" },
    variables: [
      { id: "revenue", name: "Revenue", formula: "1000", dependencies: [], tags: ["pl_metric", "input", "percent_delta"], metric_type: "currency" },
      { id: "cogs", name: "COGS", formula: "600", dependencies: [], tags: ["pl_metric", "input", "percent_delta"], metric_type: "currency" },
      { id: "gross_profit", name: "GP", formula: "revenue - cogs", dependencies: ["revenue", "cogs"], tags: ["pl_metric", "output"], metric_type: "currency" },
      { id: "gross_margin", name: "GM%", formula: "(gross_profit / revenue) * 100", dependencies: ["gross_profit", "revenue"], tags: ["pl_metric", "output"], metric_type: "percent" },
    ],
    ...overrides,
  };
  return { model: new CompiledModel(def), def };
}

test("aggregate xlsx: margin weighted, revenue summed", () => {
  const periods = [
    { period: "Q1", pl: { revenue: 1000, gross_margin: 0.4 }, variables: {} },
    { period: "Q2", pl: { revenue: 3000, gross_margin: 0.5 }, variables: {} },
  ];
  const { aggregate } = aggregateXlsxPeriodPl(periods, ["revenue", "gross_margin"]);
  assert.strictEqual(aggregate.revenue, 4000);
  // weighted: (0.4*1000 + 0.5*3000) / 4000 = 0.475 → round2 → 0.48
  assert.ok(Math.abs(aggregate.gross_margin - 0.48) < 1e-9, `got ${aggregate.gross_margin}`);
});

test("aggregate: revenue sums, gross_margin is ratio not ×N", () => {
  const { model, def } = makeModel();
  const ctx = model.evaluate({});
  const periods = [0, 1, 2, 3].map((i) => ({
    period: `2026-Q${i + 1}`,
    pl: {
      revenue: ctx.revenue,
      cogs: ctx.cogs,
      gross_profit: ctx.gross_profit,
      gross_margin: ctx.gross_margin,
    },
    variables: { ...ctx },
  }));
  const agg = aggregatePeriodPl(model, def, periods, {});
  assert.strictEqual(agg.revenue, 4000);
  assert.strictEqual(agg.gross_profit, 1600);
  assert.ok(Math.abs(agg.gross_margin - 40) < 0.01, `expected ~40 got ${agg.gross_margin}`);
});

test("aggregate: legacy model without metric_type still ratios correctly via inference", () => {
  const def: ModelDefinition = {
    model_version: "legacy",
    time_horizon: { start: "2026-Q1", end: "2026-Q4", granularity: "quarterly" },
    variables: [
      { id: "revenue", name: "Revenue", formula: "1000", dependencies: [], tags: ["pl_metric", "input"] },
      { id: "cogs", name: "COGS", formula: "600", dependencies: [], tags: ["pl_metric", "input"] },
      { id: "gross_profit", name: "GP", formula: "revenue - cogs", dependencies: ["revenue", "cogs"], tags: ["pl_metric"] },
      { id: "gross_margin", name: "Gross Margin", formula: "(gross_profit / revenue) * 100", dependencies: ["gross_profit", "revenue"], tags: ["pl_metric"] },
    ],
  };
  const model = new CompiledModel(def);
  const ctx = model.evaluate({});
  const periods = [0, 1, 2, 3].map((i) => ({
    period: `Q${i}`,
    pl: { revenue: ctx.revenue, cogs: ctx.cogs, gross_profit: ctx.gross_profit, gross_margin: ctx.gross_margin },
    variables: { ...ctx },
  }));
  const agg = aggregatePeriodPl(model, def, periods, {});
  assert.strictEqual(agg.revenue, 4000);
  assert.ok(Math.abs(agg.gross_margin - 40) < 0.01);
});

test("growth: revenue compounds 5%/quarter over 4 periods; margin stays ratio-correct", () => {
  const { model, def } = makeModel({
    variables: [
      { id: "revenue", name: "Revenue", formula: "1000", dependencies: [], tags: ["pl_metric", "input"], metric_type: "currency", period_growth_pct: 5 },
      { id: "cogs", name: "COGS", formula: "600", dependencies: [], tags: ["pl_metric", "input"], metric_type: "currency", period_growth_pct: 5 },
      { id: "gross_profit", name: "GP", formula: "revenue - cogs", dependencies: ["revenue", "cogs"], tags: ["pl_metric"], metric_type: "currency" },
      { id: "gross_margin", name: "GM%", formula: "(gross_profit / revenue) * 100", dependencies: ["gross_profit", "revenue"], tags: ["pl_metric"], metric_type: "percent" },
    ],
  });
  assert.ok(hasPeriodGrowth(def));
  const periods = [0, 1, 2, 3].map((t) => {
    const fromBase = periodOverrides(def, { revenue: 1000, cogs: 600 }, t);
    const ctx = model.evaluate(fromBase);
    return {
      period: `Q${t}`,
      pl: { revenue: ctx.revenue, cogs: ctx.cogs, gross_profit: ctx.gross_profit, gross_margin: ctx.gross_margin },
      variables: { ...ctx },
    };
  });
  assert.ok(Math.abs(periods[0].pl.revenue - 1000) < 0.01);
  assert.ok(Math.abs(periods[1].pl.revenue - 1050) < 0.01);
  assert.ok(Math.abs(periods[2].pl.revenue - 1102.5) < 0.01);
  assert.ok(Math.abs(periods[3].pl.revenue - 1157.63) < 0.1);
  const agg = aggregatePeriodPl(model, def, periods, {});
  const expectedRev = periods.reduce((s, p) => s + p.pl.revenue, 0);
  assert.ok(Math.abs(agg.revenue - expectedRev) < 0.1);
  assert.ok(Math.abs(agg.gross_margin - 40) < 0.01);
});

test("growth: applies to variables the scenario does not override (falls back to model base)", () => {
  const { model, def } = makeModel({
    variables: [
      { id: "revenue", name: "Revenue", formula: "1000", dependencies: [], tags: ["pl_metric", "input"], metric_type: "currency", period_growth_pct: 5 },
      { id: "cogs", name: "COGS", formula: "600", dependencies: [], tags: ["pl_metric", "input"], metric_type: "currency" },
      { id: "gross_profit", name: "GP", formula: "revenue - cogs", dependencies: ["revenue", "cogs"], tags: ["pl_metric"], metric_type: "currency" },
      { id: "gross_margin", name: "GM%", formula: "(gross_profit / revenue) * 100", dependencies: ["gross_profit", "revenue"], tags: ["pl_metric"], metric_type: "percent" },
    ],
  });
  const baseCtx = model.baseValues();
  // Scenario only touches cogs; revenue must still compound from its model base.
  const scenarioAbs = { cogs: 660 };
  const q2 = periodOverrides(def, scenarioAbs, 2, baseCtx);
  assert.ok(Math.abs(q2.revenue - 1102.5) < 0.01, `expected revenue 1102.5 got ${q2.revenue}`);
  assert.strictEqual(q2.cogs, 660);
  // A scenario override on the growth variable wins as the period-0 base.
  const q1 = periodOverrides(def, { revenue: 2000 }, 1, baseCtx);
  assert.ok(Math.abs(q1.revenue - 2100) < 0.01, `expected revenue 2100 got ${q1.revenue}`);
});
