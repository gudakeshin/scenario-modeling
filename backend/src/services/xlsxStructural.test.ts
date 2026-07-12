import test from "node:test";
import assert from "node:assert";
import ExcelJS from "exceljs";
import {
  extractWorkbookGraph,
  extractWorkbookArtifact,
  extractReadsFrom,
} from "./excelExtractor.js";
import { densifySnapshot, classifyWorkbookContent, ARTIFACT_VERSION } from "./ingestionArtifacts.js";
import { detectDenominationFromText, normalizeCurrencyUnit } from "./denomination.js";
import { extractTabularArtifact } from "./csvIngestor.js";
import {
  ensureScenarioContext,
  mergeTouchedLevers,
  lockLever,
  resetUnlockedLevers,
  getScenarioContext,
} from "./scenarioContextService.js";

test("excelExtractor: builds dependency graph and detects time axis", async () => {
  const wb = new ExcelJS.Workbook();
  const assumptions = wb.addWorksheet("Assumptions");
  assumptions.getCell("A1").value = "All figures in INR Million";
  assumptions.getCell("A2").value = "Volume Growth";
  assumptions.getCell("B2").value = 0.06;
  assumptions.getCell("B4").value = "Base";

  const volume = wb.addWorksheet("Volume_Plan");
  volume.getCell("A1").value = "Product";
  volume.getCell("B1").value = "Apr-24";
  volume.getCell("C1").value = "May-24";
  volume.getCell("D1").value = "FY Total";
  volume.getCell("A2").value = "Bullet";
  volume.getCell("B2").value = { formula: "Assumptions!B2*1000", result: 60 };

  const pnl = wb.addWorksheet("P&L");
  pnl.getCell("A1").value = "Revenue";
  pnl.getCell("B1").value = { formula: "Volume_Plan!B2*100", result: 6000 };

  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  const graph = await extractWorkbookGraph(buffer);

  assert.ok(graph.sheets["Volume_Plan"], "Volume_Plan sheet should be present");
  assert.ok(graph.dependencies.length > 0, "should extract formula dependencies");
  assert.ok(
    graph.dependencies.some((d) => d.readsFrom.some((r) => r.includes("Assumptions!B2"))),
    "dependencies should include cross-sheet reads",
  );
  assert.ok(graph.timeAxis?.columns && graph.timeAxis.columns.length >= 2, "should detect time columns");
  assert.strictEqual(graph.currency, "INR");
  assert.strictEqual(graph.unit, "Million");
  assert.ok(graph.cellSnapshot, "densified snapshot present via extractWorkbookGraph");
});

test("excelExtractor: preserves formulas in sparse artifact and quoted sheet names", async () => {
  const wb = new ExcelJS.Workbook();
  const assumptions = wb.addWorksheet("Assumptions");
  assumptions.getCell("A1").value = "All figures in INR Lacs";
  assumptions.getCell("A2").value = "Price";
  assumptions.getCell("B2").value = 10;

  const pnl = wb.addWorksheet("P&L Summary");
  pnl.getCell("A1").value = "Revenue";
  pnl.getCell("B1").value = { formula: "'P&L Summary'!B2+Assumptions!B2", result: 10 };
  pnl.getCell("A2").value = "Base";
  pnl.getCell("B2").value = 0;

  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  const artifact = await extractWorkbookArtifact(buffer);

  assert.strictEqual(artifact.kind, "workbook");
  assert.strictEqual(artifact.artifact_version, ARTIFACT_VERSION);
  assert.ok(artifact.snapshot, "sparse snapshot always retained");
  assert.ok(artifact.snapshot!.formulaCount >= 1);
  assert.strictEqual(artifact.unit, "Lakh", "Lac/Lacs normalize to Lakh");

  const dense = densifySnapshot(artifact.snapshot!);
  assert.ok(dense["P&L Summary"], "quoted/special sheet name preserved");
  assert.ok(
    String(dense["P&L Summary"][0][1]).includes("Assumptions!B2") ||
      String(dense["P&L Summary"][0][1]).includes("'P&L Summary'"),
    "formula string preserved in snapshot",
  );

  // Artifact v2: formula cells carry Excel cached result as expected
  const formulaCell = artifact.snapshot!.sheets["P&L Summary"].cells.find(
    (c) => typeof c.v === "string" && String(c.v).startsWith("="),
  );
  assert.ok(formulaCell, "formula sparse cell present");
  assert.strictEqual(typeof formulaCell!.v, "string");
  assert.ok(
    formulaCell!.expected === 10 || formulaCell!.expected === undefined,
    "expected is Excel cached result when available",
  );
  if (formulaCell!.expected != null) {
    assert.strictEqual(formulaCell!.expected, 10);
  }

  const refs = extractReadsFrom("='P&L Summary'!$B$1+Assumptions!A2");
  assert.ok(refs.some((r) => r.includes("P&L Summary!B1")));
  assert.ok(refs.some((r) => r.includes("Assumptions!A2")));
});

test("classifyWorkbookContent: formulas → spreadsheet_model; flat dump → tabular_data", async () => {
  const modelWb = new ExcelJS.Workbook();
  const a = modelWb.addWorksheet("Assumptions");
  a.getCell("A1").value = "Growth";
  a.getCell("B1").value = 0.05;
  const p = modelWb.addWorksheet("P&L");
  p.getCell("A1").value = "Rev";
  p.getCell("B1").value = { formula: "Assumptions!B1*1000", result: 50 };
  const modelArtifact = await extractWorkbookArtifact(Buffer.from(await modelWb.xlsx.writeBuffer()));
  const modelClass = classifyWorkbookContent(modelArtifact);
  assert.strictEqual(modelClass.document_kind, "spreadsheet_model");
  assert.ok(modelClass.evidence.has_formulas);

  const flatWb = new ExcelJS.Workbook();
  const data = flatWb.addWorksheet("Export");
  data.getCell("A1").value = "Name";
  data.getCell("B1").value = "Amount";
  data.getCell("A2").value = "Alpha";
  data.getCell("B2").value = 100;
  data.getCell("A3").value = "Beta";
  data.getCell("B3").value = 200;
  const flatArtifact = await extractWorkbookArtifact(Buffer.from(await flatWb.xlsx.writeBuffer()));
  const flatClass = classifyWorkbookContent(flatArtifact);
  assert.strictEqual(flatClass.document_kind, "tabular_data");
  assert.ok(!flatClass.evidence.has_formulas);
  assert.ok(!flatClass.evidence.has_assumption_sheets);
});

test("denomination: Crore and Lac aliases", () => {
  assert.strictEqual(normalizeCurrencyUnit("Rs. in Crores"), "Crore");
  assert.strictEqual(normalizeCurrencyUnit("INR Lacs"), "Lakh");
  assert.strictEqual(normalizeCurrencyUnit("figures in lac"), "Lakh");
  const d = detectDenominationFromText("All figures in INR Crore\nRevenue 12");
  assert.strictEqual(d.currency, "INR");
  assert.strictEqual(d.unit, "Crore");
});

test("csvIngestor: typed data-only artifact with no formulas", () => {
  const csv = Buffer.from(
    "Name,Amount\n\"Acme, Inc.\",1000\nBeta,2000\nAll figures in INR Crores\n",
    "utf-8",
  );
  const artifact = extractTabularArtifact(csv);
  assert.strictEqual(artifact.kind, "tabular");
  assert.strictEqual(artifact.dataOnly, true);
  assert.ok(artifact.headers.includes("Name"));
  assert.ok(artifact.rowCount >= 2);
  assert.strictEqual(artifact.unit, "Crore");
  assert.ok(artifact.warnings.some((w) => w.code === "csv_data_only"));
});

test("scenarioContextService: additive touched levers with lock/reset", async () => {
  const scenarioId = `test-${Date.now()}`;
  ensureScenarioContext(scenarioId);

  mergeTouchedLevers(scenarioId, [
    { id: "revenue_growth", value: 0.1, nlSource: "increase revenue growth to 10%" },
  ]);
  mergeTouchedLevers(scenarioId, [
    { id: "marketing_spend", value: 0.05, nlSource: "set marketing to 5%" },
  ]);

  const ctx = getScenarioContext(scenarioId);
  assert.ok(ctx, "context should exist");
  assert.strictEqual(ctx?.touchedLevers.length, 2, "levers should accumulate additively");

  lockLever(scenarioId, "revenue_growth", true);
  resetUnlockedLevers(scenarioId);

  const afterReset = getScenarioContext(scenarioId);
  assert.ok(afterReset, "context should exist after reset");
  assert.strictEqual(afterReset?.touchedLevers.length, 1, "only locked lever should remain");
  assert.strictEqual(afterReset?.touchedLevers[0].id, "revenue_growth");
});
