/**
 * Locks the showcase golden base-case P&L artifact against the E2E formula model.
 */

import test from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CompiledModel } from "./expression.js";

const golden = JSON.parse(
  readFileSync(join(process.cwd(), "src/tests/fixtures/golden_base_case_pl.json"), "utf8"),
) as {
  base_case: Record<string, number>;
  scenario_revenue_plus_8pct: Record<string, number>;
  deltas_revenue_plus_8pct: Record<string, number>;
};

const E2E_FORMULA = {
  model_version: "e2e-formula-golden",
  variables: [
    { id: "revenue", name: "Revenue", formula: "100000", dependencies: [], tags: ["pl_metric", "percent_delta"] },
    { id: "raw_materials", name: "Raw Materials", formula: "30000", dependencies: [], tags: ["pl_metric", "percent_delta"] },
    { id: "opex", name: "OpEx", formula: "20000", dependencies: [], tags: ["pl_metric", "percent_delta"] },
    {
      id: "gross_profit",
      name: "Gross Profit",
      formula: "revenue - raw_materials",
      dependencies: ["revenue", "raw_materials"],
      tags: ["pl_metric"],
    },
    {
      id: "ebit",
      name: "EBIT",
      formula: "gross_profit - opex",
      dependencies: ["gross_profit", "opex"],
      tags: ["pl_metric"],
    },
    { id: "tax", name: "Tax", formula: "ebit * 0.25", dependencies: ["ebit"], tags: ["pl_metric"] },
    {
      id: "net_income",
      name: "Net Income",
      formula: "ebit - tax",
      dependencies: ["ebit", "tax"],
      tags: ["pl_metric"],
    },
  ],
  time_horizon: { start: "2024-01", end: "2024-12", granularity: "monthly" as const },
};

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function roundMap(m: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, round6(v)]));
}

test("golden base-case P&L matches CompiledModel evaluation", () => {
  const model = new CompiledModel(E2E_FORMULA);
  const base = roundMap(model.evaluate({}));
  const scen = roundMap(model.evaluate({ revenue: 108000 }));

  for (const [k, v] of Object.entries(golden.base_case)) {
    assert.strictEqual(base[k], v, `base ${k}`);
  }
  for (const [k, v] of Object.entries(golden.scenario_revenue_plus_8pct)) {
    assert.strictEqual(scen[k], v, `scenario ${k}`);
  }
  for (const [k, v] of Object.entries(golden.deltas_revenue_plus_8pct)) {
    assert.strictEqual(round6(scen[k]! - base[k]!), v, `delta ${k}`);
  }
});
