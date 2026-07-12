import test from "node:test";
import assert from "node:assert";
import { CompiledModel } from "./expression.js";
import { buildDriverTree } from "./driverTreeService.js";

test("driver tree: formula model nests dependencies under net_income", () => {
  const model = new CompiledModel({
    model_version: "dt",
    time_horizon: { start: "2026-Q1", end: "2026-Q1", granularity: "quarterly" },
    variables: [
      { id: "revenue", name: "Revenue", formula: "1000", dependencies: [], tags: ["input", "pl_metric"] },
      { id: "cogs", name: "COGS", formula: "400", dependencies: [], tags: ["input", "pl_metric"] },
      {
        id: "gross_profit",
        name: "Gross Profit",
        formula: "revenue - cogs",
        dependencies: ["revenue", "cogs"],
        tags: ["pl_metric"],
      },
      {
        id: "net_income",
        name: "Net Income",
        formula: "gross_profit",
        dependencies: ["gross_profit"],
        tags: ["pl_metric"],
      },
    ],
  });
  const tree = buildDriverTree(model, {}, "net_income");
  assert.strictEqual(tree.root.id, "net_income");
  assert.ok(tree.root.children?.length);
  assert.strictEqual(tree.root.children![0].id, "gross_profit");
  assert.ok(tree.root.children![0].children?.some((c) => c.id === "revenue"));
  assert.ok(tree.apply_path?.includes("apply-lever"));
});
