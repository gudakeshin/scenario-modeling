import test from "node:test";
import assert from "node:assert";
import {
  reconcileFidelity,
  withinFidelityTolerance,
  parseA1,
} from "./fidelityReconciliation.js";
import type { SparseWorkbookSnapshot } from "./ingestionArtifacts.js";

test("withinFidelityTolerance: abs and relative gates", () => {
  assert.ok(withinFidelityTolerance(100, 100.4, 0.5, 0.01));
  assert.ok(!withinFidelityTolerance(100, 102, 0.5, 0.01));
  // Relative: 1% of 10000 = 100
  assert.ok(withinFidelityTolerance(10050, 10000, 0.5, 0.01));
  assert.ok(!withinFidelityTolerance(10200, 10000, 0.5, 0.01));
});

test("parseA1: basic refs", () => {
  assert.deepStrictEqual(parseA1("B2"), { row: 1, col: 1 });
  assert.deepStrictEqual(parseA1("$AA$10"), { row: 9, col: 26 });
});

test("reconcileFidelity: perfect match → ready", () => {
  const sparse: SparseWorkbookSnapshot = {
    format: "sparse_v1",
    sheetOrder: ["Sheet1"],
    cellCount: 3,
    formulaCount: 1,
    sheets: {
      Sheet1: {
        rows: 2,
        cols: 2,
        cells: [
          { r: 0, c: 0, v: 10 },
          { r: 0, c: 1, v: 20 },
          { r: 1, c: 0, v: "=A1+B1", expected: 30 },
        ],
      },
    },
  };

  const report = reconcileFidelity(sparse, [{ sheet: "Sheet1", cell: "A2", id: "total" }], {
    absTol: 0.5,
    relTol: 0.01,
    readyThreshold: 0.95,
  });

  assert.strictEqual(report.compared_cells, 1);
  assert.strictEqual(report.score, 1);
  assert.strictEqual(report.key_output_score, 1);
  assert.ok(report.ready);
  assert.strictEqual(report.divergences.length, 0);
});

test("reconcileFidelity: divergence blocks ready", () => {
  const sparse: SparseWorkbookSnapshot = {
    format: "sparse_v1",
    sheetOrder: ["P&L"],
    cellCount: 3,
    formulaCount: 1,
    sheets: {
      "P&L": {
        rows: 2,
        cols: 2,
        cells: [
          { r: 0, c: 0, v: 100 },
          { r: 0, c: 1, v: 50 },
          // Excel cached 200 but HF will compute 150
          { r: 1, c: 0, v: "=A1+B1", expected: 200 },
        ],
      },
    },
  };

  const report = reconcileFidelity(sparse, [{ sheet: "P&L", cell: "A2", id: "revenue" }], {
    absTol: 0.5,
    relTol: 0.01,
    readyThreshold: 0.95,
  });

  assert.strictEqual(report.compared_cells, 1);
  assert.ok(report.score < 0.95);
  assert.ok(!report.ready);
  assert.ok(report.divergences.length >= 1);
  assert.strictEqual(report.divergences[0].expected, 200);
  assert.strictEqual(report.divergences[0].actual, 150);
  assert.ok(report.divergences[0].is_key_output);
});

test("reconcileFidelity: no expected values → ready (legacy artifacts)", () => {
  const sparse: SparseWorkbookSnapshot = {
    format: "sparse_v1",
    sheetOrder: ["S"],
    cellCount: 2,
    formulaCount: 1,
    sheets: {
      S: {
        rows: 1,
        cols: 2,
        cells: [
          { r: 0, c: 0, v: 5 },
          { r: 0, c: 1, v: "=A1*2" },
        ],
      },
    },
  };

  // Legacy artifacts with no key outputs and no expected caches remain ready.
  const report = reconcileFidelity(sparse, []);
  assert.strictEqual(report.compared_cells, 0);
  assert.ok(report.ready);
  assert.strictEqual(report.score, 1);
});

test("reconcileFidelity: key outputs missing expected → not ready", () => {
  const sparse: SparseWorkbookSnapshot = {
    format: "sparse_v1",
    sheetOrder: ["P&L"],
    cellCount: 2,
    formulaCount: 1,
    sheets: {
      "P&L": {
        rows: 1,
        cols: 2,
        cells: [
          { r: 0, c: 0, v: 100 },
          { r: 0, c: 1, v: "=A1*2" }, // no expected
        ],
      },
    },
  };

  const report = reconcileFidelity(sparse, [{ sheet: "P&L", cell: "B1", id: "revenue" }]);
  assert.ok(!report.ready);
  assert.ok(report.missing_expected_key_outputs.length >= 1);
  assert.strictEqual(report.missing_expected_key_outputs[0].cell, "B1");
});

test("reconcileFidelity: unsupported XLOOKUP surfaces and blocks ready", () => {
  const sparse: SparseWorkbookSnapshot = {
    format: "sparse_v1",
    sheetOrder: ["P&L"],
    cellCount: 2,
    formulaCount: 1,
    sheets: {
      "P&L": {
        rows: 2,
        cols: 1,
        cells: [
          { r: 0, c: 0, v: "Steel" },
          {
            r: 1,
            c: 0,
            v: "=XLOOKUP(A1,A1:A1,A1:A1)",
            expected: 42,
          },
        ],
      },
    },
  };

  const report = reconcileFidelity(sparse, [{ sheet: "P&L", cell: "A2", id: "lookup" }], {
    absTol: 0.5,
    relTol: 0.01,
    readyThreshold: 0.95,
  });
  assert.ok(!report.ready);
  assert.ok(
    report.unsupported_cells.length > 0 || report.divergences.length > 0,
    "expected unsupported cell or divergence for XLOOKUP",
  );
});

test("reconcileFidelity: empty snapshot → ready", () => {
  const report = reconcileFidelity(null);
  assert.ok(report.ready);
});
