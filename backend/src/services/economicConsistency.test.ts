import test from "node:test";
import assert from "node:assert/strict";
import { economicConsistencyWarnings } from "./simulationService.js";

test("economicConsistencyWarnings: cost up + margin up → warn", () => {
  const warnings = economicConsistencyWarnings(
    { gross_margin: 40, ebitda_margin: 20, revenue: 1000 },
    { gross_margin: 55, ebitda_margin: 30, revenue: 1000 },
    [{ variableId: "raw_material_cost", value: 8, delta_type: "percent" }],
  );
  assert.ok(warnings.length >= 1);
  assert.match(warnings[0], /Accounting check/);
  assert.match(warnings[0], /raw_material_cost/);
});

test("economicConsistencyWarnings: cost up + margin down → silent", () => {
  const warnings = economicConsistencyWarnings(
    { gross_margin: 40, ebitda: 200 },
    { gross_margin: 35, ebitda: 150 },
    [{ variableId: "cogs", value: 10, delta_type: "percent" }],
  );
  assert.equal(warnings.length, 0);
});

test("economicConsistencyWarnings: absolute SET 8 on cost + rising margin → warn", () => {
  const warnings = economicConsistencyWarnings(
    { gross_margin: 40, ebitda_margin: 18 },
    { gross_margin: 90, ebitda_margin: 70 },
    [{ variableId: "raw_materials", value: 8, delta_type: "absolute" }],
  );
  assert.ok(warnings.some((w) => /absolute SET/.test(w)));
});
