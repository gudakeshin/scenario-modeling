import test from "node:test";
import assert from "node:assert";
import ExcelJS from "exceljs";
import { extractWorkbookGraph } from "./excelExtractor.js";
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
  assumptions.getCell("B4").value = "Base";
  assumptions.getCell("B8").value = 0.06;

  const volume = wb.addWorksheet("Volume_Plan");
  volume.getCell("A1").value = "Product";
  volume.getCell("B1").value = "Apr-24";
  volume.getCell("C1").value = "May-24";
  volume.getCell("D1").value = "FY Total";
  volume.getCell("A2").value = "Bullet";
  volume.getCell("B2").value = { formula: "Assumptions!B8*1000", result: 60 };

  const pnl = wb.addWorksheet("P&L");
  pnl.getCell("A1").value = "Revenue";
  pnl.getCell("B1").value = { formula: "Volume_Plan!B2*100", result: 6000 };

  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  const graph = await extractWorkbookGraph(buffer);

  assert.ok(graph.sheets["Volume_Plan"], "Volume_Plan sheet should be present");
  assert.ok(graph.dependencies.length > 0, "should extract formula dependencies");
  assert.ok(
    graph.dependencies.some((d) => d.readsFrom.some((r) => r.includes("Assumptions!B8"))),
    "dependencies should include cross-sheet reads",
  );
  assert.ok(graph.timeAxis?.columns && graph.timeAxis.columns.length >= 2, "should detect time columns");
  assert.strictEqual(graph.currency, "INR");
  assert.strictEqual(graph.unit, "Million");
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
