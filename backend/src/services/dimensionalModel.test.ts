/**
 * Dimensional engine unit tests — broadcast, signed_sum, overrides, flat-equivalence.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { CompiledModel } from "./expression.js";
import { DimensionalModel, factsToLeafMap } from "./dimensionalModel.js";
import type { DimensionalModelDefinition } from "../models/dimensions.js";
import type { ModelDefinition } from "../models/registry.js";

const flatDef: ModelDefinition = {
  model_version: "flat-1",
  variables: [
    { id: "revenue", name: "Revenue", formula: "1000", dependencies: [], tags: ["pl_metric"] },
    { id: "cogs", name: "COGS", formula: "400", dependencies: [], tags: ["pl_metric"] },
    {
      id: "gross_profit",
      name: "Gross Profit",
      formula: "revenue - cogs",
      dependencies: ["revenue", "cogs"],
      tags: ["pl_metric"],
    },
  ],
  time_horizon: { start: "2024-01", end: "2024-03", granularity: "monthly" },
};

const flatDimensional: DimensionalModelDefinition = {
  model_kind: "dimensional",
  model_version: "flat-1",
  dimensions: [],
  variables: [
    {
      id: "revenue",
      name: "Revenue",
      dims: [],
      formula: "1000",
      dependencies: [],
      aggregation: "sum",
      tags: ["pl_metric"],
    },
    {
      id: "cogs",
      name: "COGS",
      dims: [],
      formula: "400",
      dependencies: [],
      aggregation: "sum",
      tags: ["pl_metric"],
    },
    {
      id: "gross_profit",
      name: "Gross Profit",
      dims: [],
      formula: "revenue - cogs",
      dependencies: ["revenue", "cogs"],
      aggregation: "sum",
      tags: ["pl_metric"],
    },
  ],
  time_horizon: { start: "2024-01", end: "2024-03", granularity: "monthly" },
};

test("flat-equivalence: zero-dimension DimensionalModel matches CompiledModel", () => {
  const compiled = new CompiledModel(flatDef);
  const dimensional = new DimensionalModel(flatDimensional);
  const a = compiled.evaluate({});
  const b = dimensional.evaluate({});
  assert.equal(b.revenue, a.revenue);
  assert.equal(b.cogs, a.cogs);
  assert.equal(b.gross_profit, a.gross_profit);

  const a2 = compiled.evaluate({ revenue: 1200 });
  const b2 = dimensional.evaluate({ revenue: 1200 });
  assert.equal(b2.gross_profit, a2.gross_profit);
});

function regionProductModel(): {
  def: DimensionalModelDefinition;
  facts: Map<string, Map<string, number>>;
} {
  const def: DimensionalModelDefinition = {
    model_kind: "dimensional",
    model_version: "rp-1",
    dimensions: [
      {
        id: "region",
        name: "Region",
        type: "generic",
        members: [
          { id: "world", name: "World", parentId: null, isLeaf: false, sign: 1, ordinal: 0 },
          { id: "emea", name: "EMEA", parentId: "world", isLeaf: false, sign: 1, ordinal: 1 },
          { id: "amer", name: "AMER", parentId: "world", isLeaf: false, sign: 1, ordinal: 2 },
          { id: "uk", name: "UK", parentId: "emea", isLeaf: true, sign: 1, ordinal: 3 },
          { id: "de", name: "DE", parentId: "emea", isLeaf: true, sign: 1, ordinal: 4 },
          { id: "us", name: "US", parentId: "amer", isLeaf: true, sign: 1, ordinal: 5 },
        ],
      },
      {
        id: "account",
        name: "Account",
        type: "account",
        members: [
          { id: "ni", name: "Net Income", parentId: null, isLeaf: false, sign: 1, ordinal: 0 },
          { id: "rev", name: "Revenue", parentId: "ni", isLeaf: true, sign: 1, ordinal: 1 },
          { id: "exp", name: "Expense", parentId: "ni", isLeaf: true, sign: -1, ordinal: 2 },
        ],
      },
    ],
    variables: [
      {
        id: "amount",
        name: "Amount",
        dims: ["region", "account"],
        dependencies: [],
        aggregation: "signed_sum",
        tags: ["pl_metric"],
        formula: "0",
        provenance: "extracted",
      },
    ],
    time_horizon: { start: "2024-01", end: "2024-01", granularity: "monthly" },
  };

  const facts = factsToLeafMap([
    { measure_id: "amount", member_key: "uk|rev", value: 100 },
    { measure_id: "amount", member_key: "de|rev", value: 80 },
    { measure_id: "amount", member_key: "us|rev", value: 200 },
    { measure_id: "amount", member_key: "uk|exp", value: 30 },
    { measure_id: "amount", member_key: "de|exp", value: 20 },
    { measure_id: "amount", member_key: "us|exp", value: 50 },
  ]);

  return { def, facts };
}

test("signed_sum rollup applies member sign", () => {
  const { def, facts } = regionProductModel();
  const model = new DimensionalModel(def, facts);
  const result = model.evaluateDimensional([]);

  // World total: rev 100+80+200=380, exp signed -1*(30+20+50)=-100 → 280
  assert.equal(result.totals.amount, 280);

  const emea = result.valueAt("amount", { region: "emea" });
  // EMEA: rev 180, exp -50 → 130
  assert.equal(emea, 130);

  const ukRev = result.valueAt("amount", { region: "uk", account: "rev" });
  assert.equal(ukRev, 100);
});

test("scoped percent override multiplies subtree leaves", () => {
  const { def, facts } = regionProductModel();
  const model = new DimensionalModel(def, facts);
  const result = model.evaluateDimensional([
    {
      variableId: "amount",
      memberScope: { region: "emea", account: "rev" },
      value: 10,
      delta_type: "percent",
    },
  ]);
  // UK+DE rev: 100*1.1 + 80*1.1 = 198; US rev 200; expenses unchanged signed
  // total = 198+200 - (30+20+50) = 298
  assert.equal(result.totals.amount, 298);
  assert.ok(Math.abs((result.valueAt("amount", { region: "uk", account: "rev" }) ?? 0) - 110) < 1e-9);
});

test("absolute override proportional scaling", () => {
  const { def, facts } = regionProductModel();
  const model = new DimensionalModel(def, facts);
  const result = model.evaluateDimensional([
    {
      variableId: "amount",
      memberScope: { region: "emea", account: "rev" },
      value: 360, // was 180
      delta_type: "absolute",
    },
  ]);
  assert.equal(result.valueAt("amount", { region: "uk", account: "rev" }), 200);
  assert.equal(result.valueAt("amount", { region: "de", account: "rev" }), 160);
});

test("absolute override scales against signed aggregate", () => {
  const { def, facts } = regionProductModel();
  const model = new DimensionalModel(def, facts);
  const result = model.evaluateDimensional([
    {
      variableId: "amount",
      memberScope: { region: "emea" },
      value: 260, // signed EMEA total was 130
      delta_type: "absolute",
    },
  ]);
  assert.equal(result.valueAt("amount", { region: "emea" }), 260);
  assert.equal(result.valueAt("amount", { region: "uk", account: "rev" }), 200);
  assert.equal(result.valueAt("amount", { region: "uk", account: "exp" }), 60);
});

test("non-leaf region override applies to leaf subtree", () => {
  const { def, facts } = regionProductModel();
  const model = new DimensionalModel(def, facts);
  const result = model.evaluateDimensional([
    {
      variableId: "amount",
      memberScope: { region: "emea" },
      value: 10,
      delta_type: "percent",
    },
  ]);
  assert.ok(Math.abs((result.valueAt("amount", { region: "uk", account: "rev" }) ?? 0) - 110) < 1e-9);
  assert.ok(Math.abs((result.valueAt("amount", { region: "uk", account: "exp" }) ?? 0) - 33) < 1e-9);
  assert.equal(result.valueAt("amount", { region: "us", account: "rev" }), 200);
});

test("broadcast: formula with scalar + dimensional dep", () => {
  const def: DimensionalModelDefinition = {
    model_kind: "dimensional",
    model_version: "bcast",
    dimensions: [
      {
        id: "region",
        name: "Region",
        type: "generic",
        members: [
          { id: "all", name: "All", parentId: null, isLeaf: false, sign: 1, ordinal: 0 },
          { id: "a", name: "A", parentId: "all", isLeaf: true, sign: 1, ordinal: 1 },
          { id: "b", name: "B", parentId: "all", isLeaf: true, sign: 1, ordinal: 2 },
        ],
      },
    ],
    variables: [
      {
        id: "price",
        name: "Price",
        dims: [],
        formula: "10",
        dependencies: [],
        aggregation: "sum",
      },
      {
        id: "units",
        name: "Units",
        dims: ["region"],
        formula: "0",
        dependencies: [],
        aggregation: "sum",
        tags: ["pl_metric"],
      },
      {
        id: "revenue",
        name: "Revenue",
        dims: ["region"],
        formula: "price * units",
        dependencies: ["price", "units"],
        aggregation: "sum",
        tags: ["pl_metric"],
      },
    ],
    time_horizon: { start: "2024-01", end: "2024-01", granularity: "monthly" },
  };
  const facts = factsToLeafMap([
    { measure_id: "units", member_key: "a", value: 5 },
    { measure_id: "units", member_key: "b", value: 3 },
  ]);
  const model = new DimensionalModel(def, facts);
  const r = model.evaluateDimensional([]);
  assert.equal(r.valueAt("revenue", { region: "a" }), 50);
  assert.equal(r.valueAt("revenue", { region: "b" }), 30);
  assert.equal(r.totals.revenue, 80);
});

test("sparsity preserved: missing cells stay missing", () => {
  const { def, facts } = regionProductModel();
  // Remove us|exp
  facts.get("amount")!.delete("us|exp");
  const model = new DimensionalModel(def, facts);
  const r = model.evaluateDimensional([]);
  assert.equal(r.valueAt("amount", { region: "us", account: "exp" }), undefined);
  // US rev still present
  assert.equal(r.valueAt("amount", { region: "us", account: "rev" }), 200);
});

test("unknown member throws", () => {
  const { def, facts } = regionProductModel();
  const model = new DimensionalModel(def, facts);
  assert.throws(() => {
    model.evaluateDimensional([]).valueAt("amount", { region: "mars" });
  });
});

test("evaluate() totals path works for Monte Carlo contract", () => {
  const { def, facts } = regionProductModel();
  const model = new DimensionalModel(def, facts);
  assert.equal(model.kind, "dimensional");
  assert.ok(model.inputs.some((i) => i.id === "amount"));
  const totals = model.evaluate({});
  assert.equal(totals.amount, 280);
});

test("dependency cycles are rejected", () => {
  const cyclic: DimensionalModelDefinition = {
    model_kind: "dimensional",
    model_version: "cycle",
    dimensions: [],
    variables: [
      {
        id: "a",
        name: "A",
        dims: [],
        formula: "b + 1",
        dependencies: ["b"],
        aggregation: "sum",
      },
      {
        id: "b",
        name: "B",
        dims: [],
        formula: "a + 1",
        dependencies: ["a"],
        aggregation: "sum",
      },
    ],
    time_horizon: { start: "2024-01", end: "2024-01", granularity: "monthly" },
  };
  assert.throws(() => new DimensionalModel(cyclic), /circular/i);
});

test("dimensional accounting: revenue ≥ ebitda; ratios not summed", () => {
  const def: DimensionalModelDefinition = {
    model_kind: "dimensional",
    model_version: "acct-1",
    dimensions: [
      {
        id: "region",
        name: "Region",
        type: "generic",
        members: [
          { id: "total", name: "Total", parentId: null, isLeaf: false, sign: 1, ordinal: 0 },
          { id: "a", name: "A", parentId: "total", isLeaf: true, sign: 1, ordinal: 1 },
          { id: "b", name: "B", parentId: "total", isLeaf: true, sign: 1, ordinal: 2 },
        ],
      },
    ],
    variables: [
      {
        id: "revenue",
        name: "Revenue",
        dims: ["region"],
        formula: "0",
        dependencies: [],
        aggregation: "sum",
        tags: ["pl_metric"],
        metric_type: "currency",
      },
      {
        id: "gross_profit",
        name: "Gross Profit",
        dims: ["region"],
        formula: "0",
        dependencies: [],
        aggregation: "sum",
        tags: ["pl_metric"],
        metric_type: "currency",
      },
      {
        id: "operating_expenses",
        name: "OpEx",
        dims: ["region"],
        formula: "0",
        dependencies: [],
        aggregation: "sum",
        tags: ["pl_metric"],
        metric_type: "currency",
      },
      {
        id: "ebitda",
        name: "EBITDA",
        dims: ["region"],
        formula: "gross_profit - operating_expenses",
        dependencies: ["gross_profit", "operating_expenses"],
        aggregation: "sum",
        tags: ["pl_metric"],
        metric_type: "currency",
      },
      {
        id: "ebitda_margin",
        name: "EBITDA Margin",
        dims: ["region"],
        formula: "(ebitda / revenue) * 100",
        dependencies: ["ebitda", "revenue"],
        aggregation: "sum", // intentionally wrong agg — engine must not sum percents
        tags: ["pl_metric"],
        metric_type: "percent",
      },
    ],
    time_horizon: { start: "2024-01", end: "2024-01", granularity: "monthly" },
  };

  const facts = factsToLeafMap([
    { measure_id: "revenue", member_key: "a", value: 600 },
    { measure_id: "revenue", member_key: "b", value: 400 },
    { measure_id: "gross_profit", member_key: "a", value: 300 },
    { measure_id: "gross_profit", member_key: "b", value: 200 },
    { measure_id: "operating_expenses", member_key: "a", value: 100 },
    { measure_id: "operating_expenses", member_key: "b", value: 80 },
  ]);

  const model = new DimensionalModel(def, facts);
  const totals = model.evaluate({});

  assert.equal(totals.revenue, 1000);
  assert.equal(totals.gross_profit, 500);
  assert.equal(totals.operating_expenses, 180);
  assert.equal(totals.ebitda, 320);
  assert.ok(totals.revenue >= totals.ebitda, "revenue must be ≥ ebitda");
  // Margin recomputed from totals: 320/1000*100 = 32 — not sum of leaf margins
  assert.ok(Math.abs(totals.ebitda_margin - 32) < 0.01, `expected ~32, got ${totals.ebitda_margin}`);
});
