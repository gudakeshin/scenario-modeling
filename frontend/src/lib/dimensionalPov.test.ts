import { describe, expect, it } from "vitest";
import { applyPovSlice, getMemberName, setPovMember } from "./dimensionalPov";

describe("dimensional POV helpers", () => {
  it("resolves member display names across catalog shapes", () => {
    expect(getMemberName({ region: [{ id: "emea", name: "EMEA" }] }, "region", "emea")).toBe("EMEA");
    expect(getMemberName({ region: { emea: "Europe, Middle East & Africa" } }, "region", "emea"))
      .toBe("Europe, Middle East & Africa");
  });

  it("adds and clears POV members immutably", () => {
    const initial = { product: "cloud" };
    expect(setPovMember(initial, "region", "emea")).toEqual({ product: "cloud", region: "emea" });
    expect(setPovMember(initial, "product", "")).toEqual({});
    expect(initial).toEqual({ product: "cloud" });
  });

  it("uses sliced chart data while preserving omitted fields", () => {
    expect(applyPovSlice(
      { pl: { revenue: 10 }, periods: [{ period: "Q1", pl: { revenue: 10 } }] },
      { pov: { region: "emea" }, pl: { revenue: 4 } },
    )).toEqual({
      pl: { revenue: 4 },
      periods: [{ period: "Q1", pl: { revenue: 10 } }],
    });
  });
});
