/**
 * Unit tests for denomination normalization and canonical scaling.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeCurrencyCode,
  normalizeCurrencyUnit,
  toCanonical,
  toOnes,
  MixedCurrencyError,
  detectDenominationFromText,
  reconcileDenomination,
  CANONICAL_UNIT,
} from "./denomination.js";

describe("normalizeCurrencyCode", () => {
  it("recognizes INR / USD / EUR tokens", () => {
    assert.equal(normalizeCurrencyCode("All figures in INR Crore"), "INR");
    assert.equal(normalizeCurrencyCode("USD millions"), "USD");
    assert.equal(normalizeCurrencyCode("€ thousands"), "EUR");
  });

  it("rejects TOTAL / NOTES / short non-currency tokens", () => {
    assert.equal(normalizeCurrencyCode("TOTAL"), undefined);
    assert.equal(normalizeCurrencyCode("NOTES"), undefined);
    assert.equal(normalizeCurrencyCode("FY"), undefined);
    assert.equal(normalizeCurrencyCode("Q1"), undefined);
  });
});

describe("toCanonical", () => {
  it("rescales Crore into Million", () => {
    const r = toCanonical(10, { unit: "Crore", currency: "INR" });
    // 10 Crore = 100 Million
    assert.equal(r.value, 100);
    assert.equal(r.canonical_unit, CANONICAL_UNIT);
    assert.equal(r.source_unit, "Crore");
  });

  it("rescales Lakh into Million", () => {
    const r = toCanonical(100, { unit: "Lakh", currency: "INR" });
    // 100 Lakh = 10 Million
    assert.equal(r.value, 10);
  });

  it("aggregates mixed units to one canonical total", () => {
    const a = toCanonical(5, { unit: "Crore", currency: "INR" }); // 50M
    const b = toCanonical(200, { unit: "Lakh", currency: "INR" }); // 20M
    const c = toCanonical(30, { unit: "Million", currency: "INR" }); // 30M
    assert.equal(a.value + b.value + c.value, 100);
  });

  it("rejects mixed currencies without FX", () => {
    assert.throws(
      () => toCanonical(10, { unit: "Million", currency: "INR", targetCurrency: "USD" }),
      MixedCurrencyError,
    );
  });

  it("applies FX when provided", () => {
    const r = toCanonical(10, {
      unit: "Million",
      currency: "INR",
      targetCurrency: "USD",
      fxRate: 0.012,
      fxAssumption: "1 INR = 0.012 USD",
    });
    assert.ok(Math.abs(r.value - 0.12) < 1e-9);
    assert.equal(r.fx_rate, 0.012);
  });
});

describe("toOnes", () => {
  it("converts Million and Crore to absolute ones", () => {
    assert.equal(toOnes(2, "Million"), 2_000_000);
    assert.equal(toOnes(1, "Crore"), 10_000_000);
  });
});

describe("detect + reconcile", () => {
  it("detects Lac/Lacs denomination", () => {
    const d = detectDenominationFromText("All figures in INR Lacs\nRevenue 1200");
    assert.equal(d.currency, "INR");
    assert.equal(d.unit, "Lakh");
  });

  it("reconcile prefers primary graph signal", () => {
    const r = reconcileDenomination(
      { currency: "INR", unit: "Crore", evidence: ["graph"] },
      { currency: "USD", unit: "Million", evidence: ["llm"] },
    );
    assert.equal(r.currency, "INR");
    assert.equal(r.unit, "Crore");
    assert.ok(r.warnings.length >= 1);
  });
});

void normalizeCurrencyUnit;
