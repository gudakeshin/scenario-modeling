/**
 * Named-range registration into HyperFormula — formulas using names must not yield #NAME?.
 */
import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { extractWorkbookArtifact } from "./excelExtractor.js";
import { densifySnapshot } from "./ingestionArtifacts.js";
import { XlsxModelRuntime, toHyperFormulaNamedExpressions } from "./xlsxRuntime.js";
import { HyperFormula } from "hyperformula";
import { config } from "../config.js";

test("toHyperFormulaNamedExpressions: skips builtins, multi-area, bad ids", () => {
  const { expressions, warnings } = toHyperFormulaNamedExpressions(
    [
      { name: "FuelRate", refersTo: "Costs!$D$14" },
      { name: "_xlnm.Print_Area", refersTo: "Sheet1!$A$1:$B$2" },
      { name: "Multi", refersTo: "Sheet1!$A$1,Sheet1!$B$2" },
      { name: "1Bad", refersTo: "Sheet1!$A$1" },
    ],
    ["Costs", "Sheet1"],
  );
  assert.equal(expressions.length, 1);
  assert.equal(expressions[0].name, "FuelRate");
  assert.equal(expressions[0].expression, "=Costs!$D$14");
  assert.ok(warnings.some((w) => /built-in/i.test(w)));
  assert.ok(warnings.some((w) => /multi-area/i.test(w)));
  assert.ok(warnings.some((w) => /identifier/i.test(w)));
});

test("named range formulas evaluate without #NAME?", async () => {
  const wb = new ExcelJS.Workbook();
  const assumptions = wb.addWorksheet("Assumptions");
  assumptions.getCell("A1").value = "Volume";
  assumptions.getCell("B1").value = 100;
  assumptions.getCell("A2").value = "Price";
  assumptions.getCell("B2").value = 50;

  const pnl = wb.addWorksheet("PnL");
  pnl.getCell("A1").value = "Revenue";
  pnl.getCell("B1").value = { formula: "Volume*UnitPrice", result: 5000 };
  pnl.getCell("A2").value = "FuelCost";
  pnl.getCell("B2").value = 200;

  // ExcelJS add() does not persist; patch model so xlsx write emits definedNames.
  (wb.definedNames as unknown as { model: Array<{ name: string; ranges: string[] }> }).model = [
    { name: "Volume", ranges: ["Assumptions!$B$1"] },
    { name: "UnitPrice", ranges: ["Assumptions!$B$2"] },
  ];

  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  const artifact = await extractWorkbookArtifact(buffer);
  assert.ok((artifact.graph.namedRanges?.length ?? 0) >= 2, "named ranges extracted");

  const dense = densifySnapshot(artifact.snapshot!);
  const { expressions } = toHyperFormulaNamedExpressions(
    artifact.graph.namedRanges,
    Object.keys(dense),
  );
  assert.ok(expressions.some((e) => e.name === "Volume"));
  assert.ok(expressions.some((e) => e.name === "UnitPrice"));

  const hf = HyperFormula.buildFromSheets(dense as Record<string, (string | number | null)[][]>, {
    licenseKey: config.HYPERFORMULA_LICENSE_KEY,
    useColumnIndex: false,
  });
  for (const e of expressions) {
    hf.addNamedExpression(e.name, e.expression);
  }
  const pnlId = hf.getSheetId("PnL");
  assert.ok(pnlId != null);
  const revenue = hf.getCellValue({ sheet: pnlId!, row: 0, col: 1 });
  assert.equal(revenue, 5000, `expected 5000, got ${String(revenue)}`);

  const graph = { ...artifact.graph, cellSnapshot: dense };
  const built = XlsxModelRuntime.build(graph, {
    scenarioLevers: [
      { id: "fuel_cost", label: "FuelCost", sheet: "PnL", cell: "B2", scenarios: { base: 200 } },
    ],
    outputMetrics: [{ id: "revenue", label: "Revenue", sheet: "PnL", cell: "B1" }],
  });
  assert.ok(built.ok, built.errors.join("; "));
  const out = built.runtime!.evaluate({});
  assert.equal(out.revenue, 5000);
});
