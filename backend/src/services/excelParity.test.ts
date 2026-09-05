/**
 * Excel ↔ HyperFormula parity suite for finance-relevant functions.
 *
 * Golden values are Excel-correct where independently verified; cells that
 * HyperFormula cannot evaluate are recorded in `unsupported` and become the
 * authoritative unsupported-function list for Phase 3.5.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";
import { HyperFormula, DetailedCellError } from "hyperformula";
import { config } from "../config.js";
import { PARITY_UNSUPPORTED_FUNCTIONS } from "./excelParitySupport.generated.js";
import { extractWorkbookArtifact } from "./excelExtractor.js";
import { densifySnapshot } from "./ingestionArtifacts.js";
import { toHyperFormulaNamedExpressions } from "./xlsxRuntime.js";

const BACKEND_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const GOLDEN_PATH = join(BACKEND_ROOT, "src/tests/fixtures/excel_parity_golden.json");

interface GoldenCell {
  sheet: string;
  cell: string;
  /** Excel-correct expected value (null = expect unsupported / error). */
  expected: number | string | null;
  actual?: number | string | boolean | null;
  formula: string;
  note?: string;
}

interface GoldenFile {
  generated_note: string;
  cells: GoldenCell[];
  /** Function names that failed parity — feeds unsupported detection. */
  unsupported: string[];
}

function isCellError(v: unknown): boolean {
  return (
    v instanceof DetailedCellError ||
    (typeof v === "object" && v != null && "type" in (v as object))
  );
}

async function buildParityWorkbook(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const s = wb.addWorksheet("Parity");

  // Literals / helpers
  s.getCell("A1").value = 100;
  s.getCell("A2").value = 200;
  s.getCell("A3").value = 300;
  s.getCell("B1").value = "x";
  s.getCell("B2").value = "y";
  s.getCell("B3").value = "z";
  s.getCell("C1").value = 10;
  s.getCell("C2").value = 20;
  s.getCell("C3").value = 30;

  // Logic
  s.getCell("E1").value = { formula: "IF(A1>50,1,0)", result: 1 };
  s.getCell("E2").value = { formula: "AND(A1>50,A2>50)", result: true };
  s.getCell("E3").value = { formula: "OR(A1<0,A2>100)", result: true };
  s.getCell("E4").value = { formula: 'IFS(A1>500,"hi",A1>50,"mid",TRUE,"lo")', result: "mid" };

  // Lookups
  s.getCell("E5").value = { formula: 'VLOOKUP("y",B1:C3,2,FALSE)', result: 20 };
  s.getCell("E6").value = { formula: "INDEX(C1:C3,2)", result: 20 };
  s.getCell("E7").value = { formula: 'MATCH("z",B1:B3,0)', result: 3 };
  s.getCell("E8").value = { formula: "SUMIF(B1:B3,\"y\",C1:C3)", result: 20 };
  s.getCell("E9").value = { formula: "SUMPRODUCT(A1:A3,C1:C3)", result: 14000 };

  // Finance
  s.getCell("E10").value = { formula: "NPV(0.1,100,200,300)", result: 481.59 };
  s.getCell("E11").value = { formula: "PMT(0.05/12,60,-10000)", result: 188.71 };
  s.getCell("E12").value = { formula: "ROUND(1.2345,2)", result: 1.23 };
  s.getCell("E13").value = { formula: "ROUNDUP(1.21,1)", result: 1.3 };
  s.getCell("E14").value = { formula: "FLOOR(1.9,1)", result: 1 };
  s.getCell("E15").value = { formula: "CEILING(1.1,1)", result: 2 };

  // Dates (serials — Excel 1900 system; HF may differ slightly)
  s.getCell("E16").value = { formula: "YEARFRAC(DATE(2024,1,1),DATE(2025,1,1))", result: 1 };
  s.getCell("E17").value = { formula: "EOMONTH(DATE(2024,1,15),1)", result: 45351 }; // 2024-02-29 serial approx

  // Named range
  (wb.definedNames as unknown as { model: Array<{ name: string; ranges: string[] }> }).model = [
    { name: "BaseAmt", ranges: ["Parity!$A$1"] },
  ];
  s.getCell("E18").value = { formula: "BaseAmt*2", result: 200 };

  // Functions often unsupported / limited
  s.getCell("E19").value = { formula: 'XLOOKUP("y",B1:B3,C1:C3)', result: 20 };
  s.getCell("E20").value = { formula: "FILTER(C1:C3,C1:C3>15)", result: 20 };

  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Excel-correct goldens for cells we assert strictly. */
const STRICT_GOLDENS: GoldenCell[] = [
  { sheet: "Parity", cell: "E1", expected: 1, formula: "IF(A1>50,1,0)" },
  { sheet: "Parity", cell: "E5", expected: 20, formula: 'VLOOKUP("y",B1:C3,2,FALSE)' },
  { sheet: "Parity", cell: "E6", expected: 20, formula: "INDEX(C1:C3,2)" },
  { sheet: "Parity", cell: "E7", expected: 3, formula: 'MATCH("z",B1:B3,0)' },
  { sheet: "Parity", cell: "E8", expected: 20, formula: 'SUMIF(B1:B3,"y",C1:C3)' },
  { sheet: "Parity", cell: "E9", expected: 14000, formula: "SUMPRODUCT(A1:A3,C1:C3)" },
  { sheet: "Parity", cell: "E12", expected: 1.23, formula: "ROUND(1.2345,2)" },
  { sheet: "Parity", cell: "E18", expected: 200, formula: "BaseAmt*2", note: "named range" },
];

function near(actual: number, expected: number, rel = 0.01): boolean {
  const thr = Math.max(0.05, Math.abs(expected) * rel);
  return Math.abs(actual - expected) <= thr;
}

test("excel parity: extract → HyperFormula → compare goldens", async () => {
  const buffer = await buildParityWorkbook();
  const artifact = await extractWorkbookArtifact(buffer);
  const dense = densifySnapshot(artifact.snapshot!);
  const { expressions } = toHyperFormulaNamedExpressions(
    artifact.graph.namedRanges,
    Object.keys(dense),
  );

  const hf = HyperFormula.buildFromSheets(dense as Record<string, (string | number | null)[][]>, {
    licenseKey: config.HYPERFORMULA_LICENSE_KEY,
    useColumnIndex: false,
  });
  for (const e of expressions) {
    try {
      hf.addNamedExpression(e.name, e.expression);
    } catch {
      /* skip */
    }
  }

  const sheetId = hf.getSheetId("Parity");
  assert.ok(sheetId != null);

  const unsupported: string[] = [];
  const results: GoldenCell[] = [];

  const probeCells: Array<{ cell: string; formula: string; expected: number | string | null }> = [
    ...STRICT_GOLDENS.map((g) => ({ cell: g.cell, formula: g.formula, expected: g.expected })),
    { cell: "E10", formula: "NPV(0.1,100,200,300)", expected: 481.59 },
    { cell: "E11", formula: "PMT(0.05/12,60,-10000)", expected: 188.71 },
    { cell: "E19", formula: 'XLOOKUP("y",B1:B3,C1:C3)', expected: 20 },
    { cell: "E20", formula: "FILTER(C1:C3,C1:C3>15)", expected: null },
  ];

  for (const p of probeCells) {
    const col = p.cell.charCodeAt(0) - 65;
    const row = parseInt(p.cell.slice(1), 10) - 1;
    const val = hf.getCellValue({ sheet: sheetId!, row, col });
    const fnMatch = p.formula.match(/^([A-Z][A-Z0-9.]*)\s*\(/i);
    const fnName = fnMatch?.[1]?.toUpperCase();

    if (isCellError(val) || val == null) {
      if (fnName) unsupported.push(fnName);
      results.push({
        sheet: "Parity",
        cell: p.cell,
        expected: p.expected,
        actual: null,
        formula: p.formula,
        note: `HF error: ${String((val as { type?: string })?.type || val)}`,
      });
      continue;
    }

    results.push({
      sheet: "Parity",
      cell: p.cell,
      expected: p.expected,
      actual: typeof val === "number" || typeof val === "string" || typeof val === "boolean"
        ? (val as number | string)
        : String(val),
      formula: p.formula,
    });

    if (p.expected == null) continue;
    if (typeof p.expected === "number" && typeof val === "number") {
      assert.ok(
        near(val, p.expected),
        `${p.cell} ${p.formula}: expected ~${p.expected}, got ${val}`,
      );
    } else if (typeof p.expected === "string") {
      assert.equal(String(val), p.expected, `${p.cell}`);
    }
  }

  // The committed artifact is reviewed and consumed by ingestion. A pinned-HF
  // behavior change must fail here until the artifact is deliberately updated.
  const loaded = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as GoldenFile;
  const detectedUnsupported = [...new Set(unsupported)].sort();
  assert.deepEqual(detectedUnsupported, loaded.unsupported);
  assert.deepEqual(
    detectedUnsupported,
    [...PARITY_UNSUPPORTED_FUNCTIONS].sort(),
    "generated ingestion list must match runtime parity failures",
  );

  for (const g of STRICT_GOLDENS) {
    const row = loaded.cells.find((c) => c.cell === g.cell);
    assert.ok(row, `missing golden for ${g.cell}`);
  }

  const vlookupWarning = artifact.warnings.find(
    (warning) =>
      warning.code === "unsupported_function" &&
      warning.message.includes("VLOOKUP") &&
      warning.message.includes("compatibility validation"),
  );
  assert.ok(vlookupWarning, "registered functions that fail parity must warn during ingestion");

  // Ensure every probed formula remains represented in the reviewed artifact.
  for (const result of results) {
    assert.ok(
      loaded.cells.some((cell) => cell.cell === result.cell && cell.formula === result.formula),
      `missing reviewed parity artifact row for ${result.cell}`,
    );
  }
});
