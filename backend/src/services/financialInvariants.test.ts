import test from "node:test";
import assert from "node:assert/strict";
import {
  checkInvariants,
  attemptDeterministicNormalization,
} from "./financialInvariants.js";

test("checkInvariants: EBITDA > Revenue flagged", () => {
  const violations = checkInvariants(
    { revenue: 1000, ebitda: 1200, gross_profit: 600 },
    { skipIdentity: true },
  );
  assert.ok(violations.some((v) => v.code === "order_revenue_ebitda"));
  assert.ok(violations.some((v) => v.metric === "ebitda"));
});

test("checkInvariants: margin > 100% flagged", () => {
  const violations = checkInvariants(
    { revenue: 1000, ebitda: 200, ebitda_margin: 160 },
    { skipIdentity: true },
  );
  assert.ok(violations.some((v) => v.code === "ratio_over_ebitda_margin"));
  assert.ok(violations.some((v) => v.actual === 160));
});

test("checkInvariants: valid P&L is clean", () => {
  const violations = checkInvariants({
    revenue: 1000,
    cogs: 400,
    gross_profit: 600,
    operating_expenses: 200,
    ebitda: 400,
    depreciation_amortization: 50,
    ebit: 350,
    operating_income: 350,
    profit_before_tax: 350,
    tax_expense: 70,
    net_income: 280,
    gross_margin: 60,
    ebitda_margin: 40,
    net_margin: 28,
  });
  assert.equal(violations.length, 0);
});

test("attemptDeterministicNormalization: sign-flipped OpEx normalized", () => {
  // Bug pattern: EBITDA computed as GP + |OpEx| instead of GP − OpEx
  const broken = {
    revenue: 1000,
    gross_profit: 600,
    operating_expenses: 200,
    ebitda: 800, // 600 + 200 — wrong
    ebitda_margin: 80,
  };
  const before = checkInvariants(broken, { skipIdentity: true });
  assert.ok(before.some((v) => v.code === "order_revenue_ebitda") || broken.ebitda > broken.gross_profit);

  const { pl, applied, residualViolations } = attemptDeterministicNormalization(broken);
  assert.ok(applied.length > 0, "expected at least one repair");
  assert.ok(pl.ebitda <= pl.revenue + 1e-6, `ebitda ${pl.ebitda} should be ≤ revenue`);
  assert.ok(
    Math.abs(pl.ebitda - (pl.gross_profit - Math.abs(pl.operating_expenses))) < 1,
    "ebitda should equal GP − OpEx",
  );
  assert.ok(
    !residualViolations.some((v) => v.code === "order_revenue_ebitda"),
    "revenue ≥ ebitda should hold after repair",
  );
});

test("attemptDeterministicNormalization: recomputes margin from num/den", () => {
  const { pl, applied } = attemptDeterministicNormalization({
    revenue: 1000,
    gross_profit: 400,
    ebitda: 200,
    gross_margin: 160, // summed percents artifact
    ebitda_margin: 90,
  });
  assert.ok(applied.some((a) => /gross_margin/.test(a)));
  assert.ok(Math.abs(pl.gross_margin - 40) < 0.01);
  assert.ok(Math.abs(pl.ebitda_margin - 20) < 0.01);
});

test("checkInvariants: identity cross-foot catches bad EBITDA", () => {
  const violations = checkInvariants({
    revenue: 1000,
    gross_profit: 600,
    operating_expenses: 200,
    ebitda: 800, // should be 400
  });
  assert.ok(violations.some((v) => v.code === "identity_ebitda" || v.code === "order_revenue_ebitda"));
});
