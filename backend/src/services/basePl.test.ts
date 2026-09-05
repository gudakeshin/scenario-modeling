import test from "node:test";
import assert from "node:assert";
import { basePlFromOutput } from "./basePl.js";
import { compareFromOutputs } from "./comparisonService.js";

test("basePlFromOutput: reads persisted base_pl", () => {
  const bp = basePlFromOutput({
    aggregate: { revenue: 1100, net_income: 220 },
    base_pl: { revenue: 1000, net_income: 200 },
  });
  assert.deepStrictEqual(bp, { revenue: 1000, net_income: 200 });
});

test("compare: null model + stored base_pl → non-empty base deltas", () => {
  const raw = {
    aggregate: { revenue: 1200, net_income: 300 },
    base_pl: { revenue: 1000, net_income: 200 },
  };
  const result = compareFromOutputs(
    [{
      id: "11111111-1111-1111-1111-111111111111",
      name: "S1",
      nl_input: "test",
      created_at: "2026-01-01",
      pl: raw.aggregate,
      rawOutput: raw,
    }],
    null,
    raw.base_pl,
    ["revenue", "net_income"],
    [],
  );
  assert.ok(result.metrics.length >= 2);
  const rev = result.metrics.find((m) => m.metric === "revenue")!;
  assert.strictEqual(rev.base, 1000);
  assert.strictEqual(rev.scenarios[0].delta, 200);
});
