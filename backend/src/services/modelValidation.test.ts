import test from "node:test";
import assert from "node:assert";
import { crossFootExtractedPL } from "./modelValidation.js";

test("cross-foot: consistent P&L → no variances", () => {
  const variances = crossFootExtractedPL([
    { name: "Revenue", variable_id: "revenue", typical_value: 10000, is_input: true, formula: "10000" },
    { name: "COGS", variable_id: "cost_of_revenue", typical_value: 6000, is_input: true, formula: "6000" },
    {
      name: "GP",
      variable_id: "gross_profit",
      typical_value: 4000,
      is_input: false,
      formula: "revenue - cost_of_revenue",
      dependencies: ["revenue", "cost_of_revenue"],
    },
  ]);
  assert.strictEqual(variances.length, 0);
});

test("cross-foot: 10%-off gross_profit → one variance", () => {
  const variances = crossFootExtractedPL([
    { name: "Revenue", variable_id: "revenue", typical_value: 23700, is_input: true, formula: "23700" },
    { name: "COGS", variable_id: "cost_of_revenue", typical_value: 0, is_input: true, formula: "0" },
    {
      name: "GP",
      variable_id: "gross_profit",
      typical_value: 21500,
      is_input: false,
      formula: "revenue - cost_of_revenue",
      dependencies: ["revenue", "cost_of_revenue"],
    },
  ]);
  assert.strictEqual(variances.length, 1);
  assert.ok(variances[0].variance_pct > 1);
  assert.ok(/gross_profit/.test(variances[0].message));
});

test("cross-foot: missing deps skipped without crash", () => {
  const variances = crossFootExtractedPL([
    {
      name: "GP",
      variable_id: "gross_profit",
      typical_value: 4000,
      is_input: false,
      formula: "revenue - cost_of_revenue",
      dependencies: ["revenue", "cost_of_revenue"],
    },
  ]);
  assert.strictEqual(variances.length, 0);
});

test("cross-foot: margin ×100 formula", () => {
  const variances = crossFootExtractedPL([
    { name: "GP", variable_id: "gross_profit", typical_value: 400, is_input: true, formula: "400" },
    { name: "Rev", variable_id: "revenue", typical_value: 1000, is_input: true, formula: "1000" },
    {
      name: "GM",
      variable_id: "gross_margin",
      typical_value: 40,
      is_input: false,
      formula: "(gross_profit / revenue) * 100",
      dependencies: ["gross_profit", "revenue"],
    },
  ]);
  assert.strictEqual(variances.length, 0);

  const bad = crossFootExtractedPL([
    { name: "GP", variable_id: "gross_profit", typical_value: 400, is_input: true, formula: "400" },
    { name: "Rev", variable_id: "revenue", typical_value: 1000, is_input: true, formula: "1000" },
    {
      name: "GM",
      variable_id: "gross_margin",
      typical_value: 55,
      is_input: false,
      formula: "(gross_profit / revenue) * 100",
      dependencies: ["gross_profit", "revenue"],
    },
  ]);
  assert.strictEqual(bad.length, 1);
});

test("cross-foot: ebit == ebitda while D&A > 0 → variance", () => {
  const variances = crossFootExtractedPL([
    { name: "EBIT", variable_id: "ebit", typical_value: 5000, is_input: true, formula: "5000" },
    { name: "EBITDA", variable_id: "ebitda", typical_value: 5000, is_input: true, formula: "5000" },
    { name: "D&A", variable_id: "depreciation_amortization", typical_value: 800, is_input: true, formula: "800" },
  ]);
  assert.strictEqual(variances.length, 1);
  assert.strictEqual(variances[0].variable_id, "ebit");
  assert.ok(/D&A|depreciation/i.test(variances[0].message));
});
