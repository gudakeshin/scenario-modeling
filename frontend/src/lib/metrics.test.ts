import { describe, expect, it } from "vitest";
import { fmtMetric, fmtMetricSigned, inferMetricType } from "./metrics";

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
