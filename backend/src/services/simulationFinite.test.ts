/**
 * Unit tests for finite-output collection — core metrics must not silently become null.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { collectFiniteMetrics, type FormulaErrorMetric } from "./simulationService.js";

describe("collectFiniteMetrics", () => {
  it("keeps finite values and lists non-finite ones", () => {
    const out: Record<string, number> = {};
    const errors: FormulaErrorMetric[] = [];
    const { coreFailed } = collectFiniteMetrics(
      {
        revenue: 100,
        net_income: Number.NaN,
        gross_profit: Number.POSITIVE_INFINITY,
        opex: 40,
      },
      out,
      errors,
    );
    assert.equal(out.revenue, 100);
    assert.equal(out.opex, 40);
    assert.equal("net_income" in out, false);
    assert.equal("gross_profit" in out, false);
    assert.equal(coreFailed, true);
    assert.ok(errors.some((e) => e.metric_id === "net_income"));
    assert.ok(errors.some((e) => e.metric_id === "gross_profit"));
  });

  it("does not mark coreFailed when core metrics are finite", () => {
    const out: Record<string, number> = {};
    const errors: FormulaErrorMetric[] = [];
    const { coreFailed } = collectFiniteMetrics(
      { revenue: 100, net_income: 12, other: Number.NaN },
      out,
      errors,
    );
    assert.equal(coreFailed, false);
    assert.equal(out.revenue, 100);
    assert.equal(out.net_income, 12);
    assert.ok(errors.some((e) => e.metric_id === "other"));
  });
});
