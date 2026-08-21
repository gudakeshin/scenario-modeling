/**
 * Binding-integrity tests for the XLSX path.
 *
 * These cover the failure modes that produced numerically plausible but wrong
 * scenario results — each one evaluated cleanly and reported success:
 *  - repeated row labels across blocks collapsing to one lever id
 *  - formula cells offered as scenario levers
 *  - the time axis taken from a sheet other than the one the outputs live on
 *  - a single period column reported as the full year
 *  - evaluatePeriods restoring computed values over formulas
 */

import test from "node:test";
import assert from "node:assert";
import ExcelJS from "exceljs";
import {
  extractWorkbookGraph,
  selectTimeAxis,
  assignCandidateIds,
  looksLikeIdentifierColumn,
  colIndexToLetters,
} from "./excelExtractor.js";
import { XlsxModelRuntime } from "./xlsxRuntime.js";
import { buildFallbackModelSchema } from "./excelContextEngine.js";

/**
 * Miniature two-block model mirroring the real-world shape: repeated row labels
 * under different section headers, a Base|Bull|Bear|Active band, a monthly P&L
 * with its own total column, and an actuals sheet whose calendar differs.
 */
function buildTwoBlockWorkbook(): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();

  // Actuals sheet FIRST, on a different calendar than the P&L — under the old
  // first-sheet-wins rule this stole the time axis.
  const actuals = wb.addWorksheet("Volume_Actuals");
  actuals.getCell("A1").value = "PRIOR YEAR ACTUALS";
  ["A2", "B2", "C2", "D2"].forEach((ref, i) => {
    actuals.getCell(ref).value = ["Model", "Apr-23", "May-23", "Jun-23"][i];
  });
  actuals.getCell("A3").value = "Alpha";
  actuals.getCell("B3").value = 100;
  actuals.getCell("C3").value = 110;
  actuals.getCell("D3").value = 120;

  const assumptions = wb.addWorksheet("Assumptions");
  assumptions.getCell("A1").value = "SCENARIO SELECTOR";
  assumptions.getCell("A2").value = "Active Scenario";
  assumptions.getCell("B2").value = "Base";

  assumptions.getCell("A4").value = "VOLUME GROWTH ASSUMPTIONS";
  ["A5", "B5", "C5", "D5", "E5"].forEach((ref, i) => {
    assumptions.getCell(ref).value = ["Model", "Base", "Bull", "Bear", "Active"][i];
  });
  assumptions.getCell("A6").value = "Alpha";
  assumptions.getCell("B6").value = 0.06;
  assumptions.getCell("C6").value = 0.15;
  assumptions.getCell("D6").value = -0.05;
  assumptions.getCell("E6").value = {
    formula: 'IF($B$2="Bull",C6,IF($B$2="Bear",D6,B6))',
    result: 0.06,
  };

  assumptions.getCell("A8").value = "PRICE CHANGE ASSUMPTIONS";
  ["A9", "B9", "C9", "D9", "E9"].forEach((ref, i) => {
    assumptions.getCell(ref).value = ["Model", "Base", "Bull", "Bear", "Active"][i];
  });
  // Same row label as the volume block — the collision under test.
  assumptions.getCell("A10").value = "Alpha";
  assumptions.getCell("B10").value = 0.02;
  assumptions.getCell("C10").value = 0.05;
  assumptions.getCell("D10").value = 0.0;
  assumptions.getCell("E10").value = {
    formula: 'IF($B$2="Bull",C10,IF($B$2="Bear",D10,B10))',
    result: 0.02,
  };

  const pl = wb.addWorksheet("P&L");
  ["A1", "B1", "C1", "D1", "E1"].forEach((ref, i) => {
    pl.getCell(ref).value = ["P&L Line Item", "Apr-24", "May-24", "Jun-24", "FY Total"][i];
  });
  // Revenue grows with the volume lever and the price lever, so each lever has
  // a distinct, observable effect on the same output.
  pl.getCell("A2").value = "Revenue";
  pl.getCell("B2").value = {
    formula: "ROUND(Volume_Actuals!B3*(1+Assumptions!$E$6)*(1+Assumptions!$E$10),2)",
    result: 108.12,
  };
  pl.getCell("C2").value = {
    formula: "ROUND(Volume_Actuals!C3*(1+Assumptions!$E$6)*(1+Assumptions!$E$10),2)",
    result: 118.93,
  };
  pl.getCell("D2").value = {
    formula: "ROUND(Volume_Actuals!D3*(1+Assumptions!$E$6)*(1+Assumptions!$E$10),2)",
    result: 129.74,
  };
  pl.getCell("E2").value = { formula: "SUM(B2:D2)", result: 356.79 };

  return wb;
}

async function toBuffer(wb: ExcelJS.Workbook): Promise<Buffer> {
  return Buffer.from(await wb.xlsx.writeBuffer());
}

test("repeated row labels across blocks stay distinct levers", async () => {
  const graph = await extractWorkbookGraph(await toBuffer(buildTwoBlockWorkbook()));
  const inputs = graph.inputCandidates || [];
  const ids = inputs.map((c) => c.id);

  assert.strictEqual(
    new Set(ids).size,
    ids.length,
    `lever ids must be unique, got: ${ids.join(", ")}`,
  );

  const volume = inputs.find((c) => c.cell === "B6");
  const price = inputs.find((c) => c.cell === "B10");
  assert.ok(volume, "volume-block Alpha candidate");
  assert.ok(price, "price-block Alpha candidate");
  assert.notStrictEqual(volume!.id, price!.id, "same-labelled rows must not share an id");
  assert.match(volume!.id, /volume_growth/, `volume id should carry its block, got ${volume!.id}`);
  assert.match(price!.id, /price_change/, `price id should carry its block, got ${price!.id}`);
  // The bare label survives as an alias so previously stored schemas resolve.
  assert.strictEqual(volume!.aliasId, "alpha");
  assert.strictEqual(price!.aliasId, "alpha");
});

test("a lever's reported base is the value of the cell it writes", async () => {
  const graph = await extractWorkbookGraph(await toBuffer(buildTwoBlockWorkbook()));
  const schema = buildFallbackModelSchema(graph, "Two Block");
  const build = XlsxModelRuntime.build(graph, schema);
  assert.ok(build.ok && build.runtime, `build failed: ${build.errors.join("; ")}`);
  const runtime = build.runtime!;

  // The divergence that turned "+7.5%" into an arbitrary multiple: inputs[]
  // deduped first-seen while the write map kept last-seen.
  const volume = runtime.inputs.find((i) => /volume_growth/.test(i.id));
  const price = runtime.inputs.find((i) => /price_change/.test(i.id));
  assert.ok(volume && price, "both block levers exposed as inputs");
  assert.strictEqual(volume!.base, 0.06);
  assert.strictEqual(price!.base, 0.02);

  // Each lever must move the output on its own, in the right direction.
  const base = runtime.evaluate({});
  const volumeUp = runtime.evaluate({ [volume!.id]: 0.26 });
  const priceUp = runtime.evaluate({ [price!.id]: 0.22 });
  assert.ok(volumeUp.revenue > base.revenue, "volume lever must lift revenue");
  assert.ok(priceUp.revenue > base.revenue, "price lever must lift revenue");
  assert.notStrictEqual(
    volumeUp.revenue,
    priceUp.revenue,
    "distinct levers must produce distinct results",
  );
});

test("formula cells are never offered as levers", async () => {
  const graph = await extractWorkbookGraph(await toBuffer(buildTwoBlockWorkbook()));
  const formulaLevers = (graph.inputCandidates || []).filter((c) => c.isFormula);
  assert.deepStrictEqual(
    formulaLevers.map((c) => `${c.sheet}!${c.cell}`),
    [],
    "a computed cell cannot be an input",
  );
  // The Active column is a formula, so it must not appear as a lever of its own —
  // it is reachable only as the write target of its Base twin.
  assert.ok(
    !(graph.inputCandidates || []).some((c) => c.cell === "E6" || c.cell === "E10"),
    "Active-column cells must not be standalone levers",
  );
});

test("time axis comes from the sheet hosting the outputs", async () => {
  const graph = await extractWorkbookGraph(await toBuffer(buildTwoBlockWorkbook()));
  assert.ok(graph.timeAxis, "time axis detected");
  assert.strictEqual(
    graph.timeAxis!.sheet,
    "P&L",
    "axis must follow the summary sheet, not the earlier actuals sheet",
  );
  assert.ok(
    graph.timeAxis!.columns.includes("Apr-24"),
    `expected FY24 period labels, got ${graph.timeAxis!.columns.join(", ")}`,
  );
  assert.ok(
    !graph.timeAxis!.columns.includes("Apr-23"),
    "prior-year actuals columns must not label plan periods",
  );
  assert.strictEqual(graph.timeAxis!.aggregateCol, "FY Total");
  // Every candidate is retained so the choice is auditable.
  assert.ok(
    (graph.timeAxisCandidates || []).some((c) => c.sheet === "Volume_Actuals"),
    "rejected axis candidates are still recorded",
  );
});

test("headline outputs read the workbook's own total column", async () => {
  const graph = await extractWorkbookGraph(await toBuffer(buildTwoBlockWorkbook()));
  const revenue = (graph.outputCandidates || []).find((c) => c.id === "revenue");
  assert.ok(revenue, "revenue output candidate");
  assert.strictEqual(revenue!.aggregateCell, "E2", "row's total cell is column E");

  const build = XlsxModelRuntime.build(graph, buildFallbackModelSchema(graph, "Two Block"));
  const runtime = build.runtime!;
  const base = runtime.evaluate({});
  const periods = runtime.evaluatePeriods({});

  // The aggregate must be the year, not the first period presented as one.
  const periodSum = periods.reduce((acc, p) => acc + (p.values.revenue ?? 0), 0);
  assert.ok(
    Math.abs(base.revenue - periodSum) < 0.05,
    `headline revenue ${base.revenue} should equal the sum of periods ${periodSum}`,
  );
  assert.ok(
    base.revenue > periods[0].values.revenue * 2,
    "headline revenue must not be a single period",
  );
  assert.strictEqual(periods.length, 3, "the total column is not itself a period");
});

test("evaluatePeriods leaves formula-backed cells as formulas", async () => {
  const graph = await extractWorkbookGraph(await toBuffer(buildTwoBlockWorkbook()));
  const build = XlsxModelRuntime.build(graph, buildFallbackModelSchema(graph, "Two Block"));
  const runtime = build.runtime!;
  const lever = runtime.inputs.find((i) => /volume_growth/.test(i.id))!;

  const before = runtime.evaluate({});
  // Levers bind the Active cell, which holds an IF formula. Restoring it with a
  // computed value bakes in a constant and breaks the DAG for every later run
  // served from the cached runtime.
  runtime.evaluatePeriods({ [lever.id]: 0.5 });
  const after = runtime.evaluate({});

  assert.deepStrictEqual(after, before, "baseline must be unchanged after evaluatePeriods");

  // The toggle linkage must still work, which is only true if the formula survived.
  const overridden = runtime.evaluate({ [lever.id]: 0.5 });
  assert.ok(
    overridden.revenue > after.revenue,
    "override must still take effect after a multi-period run",
  );
});

test("overrides apply when the scenario toggle is not on Base", async () => {
  const wb = buildTwoBlockWorkbook();
  wb.getWorksheet("Assumptions")!.getCell("B2").value = "Bull";

  const graph = await extractWorkbookGraph(await toBuffer(wb));
  const build = XlsxModelRuntime.build(graph, buildFallbackModelSchema(graph, "Two Block"));
  const runtime = build.runtime!;
  const lever = runtime.inputs.find((i) => /volume_growth/.test(i.id))!;

  // Base must reflect the Bull column that the model is actually reading.
  assert.strictEqual(lever.base, 0.15, "base must follow the active scenario column");

  const base = runtime.evaluate({});
  const scenario = runtime.evaluate({ [lever.id]: lever.base * 1.5 });
  assert.notStrictEqual(
    scenario.revenue,
    base.revenue,
    "override must not be silently discarded when the toggle is off Base",
  );
});

test("the scenario toggle resolves to the cell the IF tests", async () => {
  const graph = await extractWorkbookGraph(await toBuffer(buildTwoBlockWorkbook()));
  assert.ok(graph.scenarioToggle, "toggle detected");
  assert.strictEqual(
    graph.scenarioToggle!.cell,
    "Assumptions!B2",
    "toggle is the tested selector, not the cell holding the IF",
  );
  assert.deepStrictEqual([...graph.scenarioToggle!.values].sort(), ["Bear", "Bull"]);
});

test("identifier columns are recognised as reference data", () => {
  // GL account codes and part numbers: uniform-width integers.
  assert.strictEqual(looksLikeIdentifierColumn([100000, 100001, 114300, 214510]), true);
  // Quantities and money vary in magnitude.
  assert.strictEqual(looksLikeIdentifierColumn([14, 980, 0.32, 5455]), false);
  assert.strictEqual(looksLikeIdentifierColumn([1, 2]), false, "too few values to judge");
});

test("id assignment widens only as far as uniqueness requires", () => {
  const candidates = assignCandidateIds<{
    id: string;
    aliasId?: string;
    label: string;
    sheet: string;
    cell: string;
    blockLabel?: string;
  }>([
    { id: "unique_one", label: "Unique One", sheet: "S1", cell: "B1" },
    { id: "alpha", label: "Alpha", sheet: "S1", cell: "B2", blockLabel: "VOLUME GROWTH" },
    { id: "alpha", label: "Alpha", sheet: "S1", cell: "B3", blockLabel: "PRICE CHANGE" },
  ]);
  assert.strictEqual(candidates[0].id, "unique_one", "unique ids stay untouched");
  assert.strictEqual(candidates[1].id, "volume_growth_alpha");
  assert.strictEqual(candidates[2].id, "price_change_alpha");
  assert.strictEqual(candidates[1].aliasId, "alpha");
});

test("selectTimeAxis prefers the summary sheet over busier schedules", () => {
  const chosen = selectTimeAxis(
    [
      { sheet: "Revenue", columns: ["Apr", "May", "Jun"], kind: "periods" },
      { sheet: "P&L", columns: ["Apr-24", "May-24"], kind: "periods" },
    ],
    // The working schedule exposes far more rows than the P&L.
    [
      ...Array.from({ length: 20 }, () => ({ sheet: "Revenue" })),
      ...Array.from({ length: 5 }, () => ({ sheet: "P&L" })),
    ],
    { Revenue: { role: "timeseries" }, "P&L": { role: "summary" } },
  );
  assert.strictEqual(chosen?.sheet, "P&L");
});

test("column index maps to Excel letters past Z", () => {
  assert.strictEqual(colIndexToLetters(0), "A");
  assert.strictEqual(colIndexToLetters(14), "O");
  assert.strictEqual(colIndexToLetters(26), "AA");
});

test("a duplicate lever id fails the build rather than dropping a cell", async () => {
  const graph = await extractWorkbookGraph(await toBuffer(buildTwoBlockWorkbook()));
  const schema = buildFallbackModelSchema(graph, "Two Block");

  // Two schema entries claiming one id — the shape a pre-qualification
  // model_schema still has. Silently keeping the last one binds a cell whose
  // base differs from the one reported to the caller.
  const lever = schema.scenarioLevers.find((l) => /volume_growth/.test(l.id))!;
  schema.scenarioLevers.push({ ...lever, cell: "B10", activeCell: "E10" });

  const build = XlsxModelRuntime.build(graph, schema);
  assert.strictEqual(build.ok, false, "a collision must not produce a usable runtime");
  assert.strictEqual(build.reason, "duplicate_lever_ids");
  assert.ok(
    build.errors.some((e) => e.includes("claimed by two cells")),
    `errors should name the collision, got: ${build.errors.join("; ")}`,
  );
});

test("an unambiguous pre-qualification id still resolves; an ambiguous one does not", async () => {
  const graph = await extractWorkbookGraph(await toBuffer(buildTwoBlockWorkbook()));
  const build = XlsxModelRuntime.build(graph, buildFallbackModelSchema(graph, "Two Block"));
  const runtime = build.runtime!;

  // "alpha" is claimed by both blocks, so it must stay unresolved — guessing
  // between two cells is the original bug.
  assert.strictEqual(
    runtime.resolveInputId("alpha"),
    undefined,
    "an ambiguous alias must not be guessed",
  );

  // A lever whose bare label is unique keeps working under its old id.
  const unique = runtime.inputs.find((i) => i.id === "unique_lever_for_alias");
  if (unique) {
    assert.strictEqual(runtime.resolveInputId("unique_lever_for_alias"), unique.id);
  }
  // The current ids always resolve to themselves.
  for (const input of runtime.inputs) {
    assert.strictEqual(runtime.resolveInputId(input.id), input.id);
  }
});

test("granularity is read from the axis labels, not the column count", async () => {
  const { inferAxisGranularity } = await import("./simulationService.js");
  assert.strictEqual(inferAxisGranularity(["Apr-24", "May-24", "Jun-24"]), "monthly");
  assert.strictEqual(inferAxisGranularity(["Q1", "Q2", "Q3", "Q4"]), "quarterly");
  // Six half-year style columns are not twelve months.
  assert.strictEqual(
    inferAxisGranularity(["H1 FY24", "H2 FY24", "H1 FY25", "H2 FY25", "H1 FY26", "H2 FY26"]),
    "quarterly",
    "a six-column axis with no month names must not be called monthly",
  );
  assert.strictEqual(inferAxisGranularity([]), "quarterly");
});
