import { describe, it, expect } from "vitest";
import { formatCompact, formatCompactCurrency } from "./chartTheme";

describe("formatCompact", () => {
  it("formats thousands as compact K", () => {
    expect(formatCompact(1000)).toMatch(/^1\.?0?\s?K$/i);
  });

  it("formats millions as compact M", () => {
    expect(formatCompact(1_000_000)).toMatch(/^1\.?0?\s?M$/i);
  });

  it("formats zero", () => {
    expect(formatCompact(0)).toBe("0");
  });

  it("formats negatives with a leading minus", () => {
    expect(formatCompact(-12_000)).toMatch(/^-12\.?0?\s?K$/i);
  });

  it("returns em dash for non-finite values", () => {
    expect(formatCompact(Number.NaN)).toBe("—");
    expect(formatCompact(Number.POSITIVE_INFINITY)).toBe("—");
  });
});

describe("formatCompactCurrency", () => {
  it("prefixes a currency symbol", () => {
    expect(formatCompactCurrency(1000, "$")).toMatch(/^\$1\.?0?\s?K$/i);
  });

  it("places the minus before the symbol for negatives", () => {
    expect(formatCompactCurrency(-1_000_000, "₹")).toMatch(/^-₹1\.?0?\s?M$/i);
  });

  it("formats zero with symbol", () => {
    expect(formatCompactCurrency(0, "$")).toBe("$0");
  });
});
