import { describe, expect, it } from "vitest";
import { fmtMetric, fmtMetricSigned, inferMetricType, withCanonicalMetrics } from "./metrics";

describe("inferMetricType", () => {
  it("classifies margins and rates as percent", () => {
    expect(inferMetricType("ebitda_margin")).toBe("percent");
    expect(inferMetricType("gross_margin")).toBe("percent");
    expect(inferMetricType("tax_rate", "Tax Rate")).toBe("percent");
  });

  it("classifies amounts as currency", () => {
    expect(inferMetricType("ebitda")).toBe("currency");
    expect(inferMetricType("revenue")).toBe("currency");
  });
});

describe("fmtMetric", () => {
  it("formats EBITDA margin as percent, not currency", () => {
    expect(fmtMetric("ebitda_margin", 18.5)).toBe("18.5%");
    expect(fmtMetric("ebitda_margin", 0.185)).toBe("18.5%");
  });

  it("formats signed percent deltas", () => {
    expect(fmtMetricSigned("ebitda_margin", -1.2)).toBe("-1.2%");
  });
});

// ── Canonical metric aliasing ──

describe("withCanonicalMetrics", () => {
  it("maps a workbook's own P&L vocabulary onto canonical ids", () => {
    const canonical = withCanonicalMetrics({
      gross_revenue: 101003.16,
      net_revenue: 99993.14,
      material_vehicle_cost: 59995.87,
      gross_profit: 39997.27,
      total_opex: 252.14,
      ebitda: 39745.13,
    });
    // net_revenue is the better "revenue" than gross_revenue.
    expect(canonical.revenue).toBe(99993.14);
    expect(canonical.cogs).toBe(59995.87);
    expect(canonical.opex).toBe(252.14);
    // Original ids survive so tables keep the model's real labels.
    expect(canonical.gross_revenue).toBe(101003.16);
  });

  it("leaves an already-canonical P&L untouched", () => {
    const input = { revenue: 100, cogs: 60, ebitda: 25 };
    expect(withCanonicalMetrics(input)).toEqual(input);
  });

  it("does not invent metrics a model never reported", () => {
    const canonical = withCanonicalMetrics({ some_bespoke_line: 42 });
    expect(canonical).toEqual({ some_bespoke_line: 42 });
  });

  it("handles a missing P&L", () => {
    expect(withCanonicalMetrics(null)).toEqual({});
  });
});
