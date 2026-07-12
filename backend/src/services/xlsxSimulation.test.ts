/**
 * Analytics-correctness tests:
 *  - Expression engine: compile, evaluate, error on unknown identifiers
 *  - Typed deltas: sign + percent/absolute semantics
 *  - XLSX pipeline: ExcelJS fixture → extractWorkbookGraph (cell snapshot)
 *    → XlsxModelRuntime → formula-accurate simulation (not the old
 *    average-delta heuristic), non-zero variance under different inputs
 *  - Seeded RNG: reproducibility and distribution sanity
 */

import test from "node:test";
import assert from "node:assert";
import ExcelJS from "exceljs";
import { extractWorkbookGraph, parseNumericLike } from "./excelExtractor.js";
import { extractCsvText } from "./documentService.js";
import { XlsxModelRuntime } from "./xlsxRuntime.js";
import { CompiledModel, ExpressionError, compileFormula, resolveOverride } from "./expression.js";
import { toTypedDelta, type ParsedParameter } from "./parser.js";
import { mulberry32, normal01, lognormalRandom, pertRandom, cholesky } from "./random.js";

// ── Expression engine ──

test("expression: compiles and evaluates arithmetic with variables", () => {
  const known = new Set(["revenue", "cogs"]);
  const fn = compileFormula("revenue - cogs", known);
  assert.strictEqual(fn({ revenue: 1000, cogs: 600 }, {} as never), 400);
});

test("expression: throws on unknown identifiers instead of silent 0", () => {
  assert.throws(
    () => compileFormula("revenue - unknown_thing", new Set(["revenue"]), "gross_profit"),
    (e: Error) => e instanceof ExpressionError && e.message.includes("unknown_thing") && e.message.includes("gross_profit"),
  );
});

test("expression: CompiledModel evaluates DAG and honors overrides", () => {
  const model = new CompiledModel({
    model_version: "test",
    time_horizon: { start: "2026-Q1", end: "2026-Q4", granularity: "quarterly" },
    variables: [
      { id: "revenue", name: "Revenue", formula: "1000", dependencies: [], tags: ["input", "percent_delta"] },
      { id: "cogs", name: "COGS", formula: "600", dependencies: [], tags: ["input", "percent_delta"] },
      { id: "gross_profit", name: "Gross Profit", formula: "revenue - cogs", dependencies: ["revenue", "cogs"], tags: ["pl_metric"] },
    ],
  });
  assert.strictEqual(model.evaluate({})["gross_profit"], 400);
  assert.strictEqual(model.evaluate({ revenue: 1100 })["gross_profit"], 500);
  assert.deepStrictEqual(model.inputs.map((i) => i.id).sort(), ["cogs", "revenue"]);
  assert.deepStrictEqual(model.outputIds, ["gross_profit"]);
});

// ── Typed deltas ──

function param(overrides: Partial<ParsedParameter>): ParsedParameter {
  return {
    name: "p", variable_type: "cost_change", direction: "increase",
    magnitude: 10, unit: "percent", scope: {}, confidence: 1,
    ...overrides,
  };
}

test("typed deltas: decrease flips the sign (old code applied cuts as increases)", () => {
  assert.deepStrictEqual(toTypedDelta(param({ direction: "decrease" })), { value: -10, delta_type: "percent" });
  assert.deepStrictEqual(toTypedDelta(param({ direction: "reduce" })), { value: -10, delta_type: "percent" });
  assert.deepStrictEqual(toTypedDelta(param({ direction: "increase" })), { value: 10, delta_type: "percent" });
});

test("typed deltas: 'set' and non-percent units are absolute", () => {
  assert.deepStrictEqual(toTypedDelta(param({ direction: "set", magnitude: 500 })), { value: 500, delta_type: "absolute" });
  assert.deepStrictEqual(toTypedDelta(param({ unit: "currency", magnitude: 250 })), { value: 250, delta_type: "absolute" });
});

test("typed deltas: >100% and negative percents resolve correctly", () => {
  assert.strictEqual(resolveOverride(200, { value: 150, delta_type: "percent" }), 500);
  assert.strictEqual(resolveOverride(200, { value: -10, delta_type: "percent" }), 180);
  assert.strictEqual(resolveOverride(200, { value: 42, delta_type: "absolute" }), 42);
});

// ── XLSX pipeline ──

async function buildFixtureWorkbook(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const assumptions = wb.addWorksheet("Assumptions");
  assumptions.getCell("A1").value = "Revenue Base";
  assumptions.getCell("B1").value = 1000;
  assumptions.getCell("A2").value = "Cost Ratio";
  assumptions.getCell("B2").value = 0.6;

  const pnl = wb.addWorksheet("P&L Summary");
  pnl.getCell("A1").value = "Revenue";
  pnl.getCell("B1").value = { formula: "Assumptions!B1", result: 1000 };
  pnl.getCell("A2").value = "Costs";
  pnl.getCell("B2").value = { formula: "Assumptions!B1*Assumptions!B2", result: 600 };
  pnl.getCell("A3").value = "Gross Profit";
  pnl.getCell("B3").value = { formula: "B1-B2", result: 400 };

  return Buffer.from(await wb.xlsx.writeBuffer());
}

const FIXTURE_SCHEMA = {
  scenarioLevers: [
    { id: "revenue_base", label: "Revenue Base", scenarios: { base: 1000 } },
    { id: "cost_ratio", label: "Cost Ratio", scenarios: { base: 0.6 } },
  ],
  outputMetrics: [
    { id: "revenue", label: "Revenue" },
    { id: "costs", label: "Costs" },
    { id: "gross_profit", label: "Gross Profit" },
  ],
};

test("xlsx: extractor captures a cell snapshot with formulas", async () => {
  const buffer = await buildFixtureWorkbook();
  const graph = await extractWorkbookGraph(buffer);
  assert.ok(graph.cellSnapshot, "cellSnapshot should be present");
  const pnl = graph.cellSnapshot!["P&L Summary"];
  assert.ok(pnl, "P&L sheet snapshot present");
  assert.strictEqual(pnl[2][1], "=B1-B2", "gross profit formula captured");
  const outWithCell = (graph.outputCandidates || []).find((c) => c.id === "gross_profit");
  assert.ok(outWithCell?.cell, "output candidates carry cell addresses");
});

test("xlsx: runtime propagates overrides through real formulas", async () => {
  const buffer = await buildFixtureWorkbook();
  const graph = await extractWorkbookGraph(buffer);
  const runtime = XlsxModelRuntime.fromWorkbook(graph, FIXTURE_SCHEMA);
  assert.ok(runtime, "runtime should build from snapshot");

  const base = runtime!.evaluate({});
  assert.strictEqual(base["revenue"], 1000);
  assert.strictEqual(base["costs"], 600);
  assert.strictEqual(base["gross_profit"], 400);

  // +10% revenue: costs scale (ratio-driven), GP = 1100 - 660 = 440.
  // The old average-delta heuristic would have moved EVERY output by +5%
  // (mean of +10% and 0%), giving GP = 420 — provably wrong.
  const up = runtime!.evaluate({ revenue_base: 1100 });
  assert.strictEqual(up["revenue"], 1100);
  assert.strictEqual(up["costs"], 660.0000000000001 === up["costs"] ? up["costs"] : 660, "costs follow the ratio");
  assert.ok(Math.abs(up["gross_profit"] - 440) < 1e-6, `GP should be 440, got ${up["gross_profit"]}`);

  // Cost ratio cut to 0.5: GP = 1000 - 500 = 500 (revenue unchanged)
  const cheaper = runtime!.evaluate({ cost_ratio: 0.5 });
  assert.ok(Math.abs(cheaper["gross_profit"] - 500) < 1e-6);
  assert.strictEqual(cheaper["revenue"], 1000);

  // State restored between evaluations
  const again = runtime!.evaluate({});
  assert.strictEqual(again["gross_profit"], 400, "lever cells restored after evaluate");
});

test("xlsx: different inputs give different outputs (non-zero variance)", async () => {
  const buffer = await buildFixtureWorkbook();
  const graph = await extractWorkbookGraph(buffer);
  const runtime = XlsxModelRuntime.fromWorkbook(graph, FIXTURE_SCHEMA)!;
  const samples = [950, 1000, 1050, 1100].map((v) => runtime.evaluate({ revenue_base: v })["gross_profit"]);
  const distinct = new Set(samples.map((v) => Math.round(v)));
  assert.ok(distinct.size >= 4, `expected 4 distinct outcomes, got ${[...distinct].join(", ")}`);
});

async function buildThreeHopWorkbook(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const assumptions = wb.addWorksheet("Assumptions");
  assumptions.getCell("A1").value = "Volume Growth";
  assumptions.getCell("B1").value = 0.06;

  const volume = wb.addWorksheet("Volume_Plan");
  volume.getCell("A1").value = "Units";
  volume.getCell("B1").value = { formula: "Assumptions!B1*1000", result: 60 };

  const pnl = wb.addWorksheet("P&L");
  pnl.getCell("A1").value = "Revenue";
  pnl.getCell("B1").value = { formula: "Volume_Plan!B1*100", result: 6000 };

  return Buffer.from(await wb.xlsx.writeBuffer());
}

const THREE_HOP_SCHEMA = {
  scenarioLevers: [
    { id: "volume_growth", label: "Volume Growth", sheet: "Assumptions", cell: "B1", scenarios: { base: 0.06 } },
  ],
  outputMetrics: [
    { id: "revenue", label: "Revenue", sheet: "P&L", cell: "B1", row: 1 },
  ],
};

test("xlsx: three-sheet chain propagates overrides (Assumptions → Volume → P&L)", async () => {
  const buffer = await buildThreeHopWorkbook();
  const graph = await extractWorkbookGraph(buffer);
  assert.ok(graph.cellSnapshot?.["Volume_Plan"]?.[0]?.[1] === "=Assumptions!B1*1000");
  assert.ok(graph.cellSnapshot?.["P&L"]?.[0]?.[1] === "=Volume_Plan!B1*100");

  const build = XlsxModelRuntime.build(graph, THREE_HOP_SCHEMA);
  assert.ok(build.ok && build.runtime, `runtime should build: ${build.errors.join("; ")}`);
  assert.deepStrictEqual(build.boundLevers, ["volume_growth"]);
  assert.deepStrictEqual(build.boundOutputs, ["revenue"]);

  const base = build.runtime!.evaluate({});
  assert.ok(Math.abs(base.revenue - 6000) < 1e-6, `base revenue ${base.revenue}`);

  const up = build.runtime!.evaluate({ volume_growth: 0.12 });
  assert.ok(Math.abs(up.revenue - 12000) < 1e-6, `doubled growth → revenue ${up.revenue}`);
});

test("xlsx: build reports missing snapshot and unbound metrics", () => {
  const missing = XlsxModelRuntime.build({ sheets: {}, dependencies: [] }, THREE_HOP_SCHEMA);
  assert.strictEqual(missing.ok, false);
  assert.strictEqual(missing.reason, "missing_snapshot");

  const bufferGraph: import("./excelExtractor.js").WorkbookGraph = {
    sheets: { Assumptions: { role: "assumptions", timeColumns: [], rowCount: 1, colCount: 1 } },
    dependencies: [],
    cellSnapshot: { Assumptions: [[1]] },
  };
  const unbound = XlsxModelRuntime.build(bufferGraph, THREE_HOP_SCHEMA);
  assert.strictEqual(unbound.ok, false);
  assert.ok(
    unbound.reason === "no_lever_bindings" || unbound.reason === "no_output_bindings",
    unbound.reason,
  );
});

test("xlsx: explicit schema cell bindings preferred over candidates", async () => {
  const buffer = await buildFixtureWorkbook();
  const graph = await extractWorkbookGraph(buffer);
  const schema = {
    scenarioLevers: [
      { id: "revenue_base", label: "Revenue Base", sheet: "Assumptions", cell: "B1", scenarios: { base: 1000 } },
    ],
    outputMetrics: [
      { id: "gross_profit", label: "Gross Profit", sheet: "P&L Summary", cell: "B3", row: 3 },
    ],
  };
  const runtime = XlsxModelRuntime.fromWorkbook(graph, schema);
  assert.ok(runtime);
  assert.ok(Math.abs(runtime!.evaluate({}).gross_profit - 400) < 1e-6);
});

/** Quarterly P&L with Q1–Q4 columns; Excel cached results must match HyperFormula. */
async function buildQuarterlyWorkbook(): Promise<{
  buffer: Buffer;
  cached: { period: string; revenue: number; costs: number; gross_profit: number; gross_margin: number }[];
}> {
  const wb = new ExcelJS.Workbook();
  const assumptions = wb.addWorksheet("Assumptions");
  assumptions.getCell("A1").value = "Revenue Base";
  assumptions.getCell("B1").value = 1000;
  assumptions.getCell("A2").value = "Cost Ratio";
  assumptions.getCell("B2").value = 0.6;

  const periods = ["Q1", "Q2", "Q3", "Q4"] as const;
  const growth = [1.0, 1.05, 1.1, 1.15];
  const pnl = wb.addWorksheet("P&L");
  pnl.getCell("A1").value = "Metric";
  periods.forEach((p, i) => {
    pnl.getCell(1, i + 2).value = p;
  });

  pnl.getCell("A2").value = "Revenue";
  pnl.getCell("A3").value = "Costs";
  pnl.getCell("A4").value = "Gross Profit";
  pnl.getCell("A5").value = "Gross Margin";

  const cached: { period: string; revenue: number; costs: number; gross_profit: number; gross_margin: number }[] = [];
  for (let i = 0; i < 4; i++) {
    const col = i + 2;
    const rev = 1000 * growth[i];
    const costs = rev * 0.6;
    const gp = rev - costs;
    const margin = gp / rev;
    const revCol = String.fromCharCode(64 + col); // B,C,D,E
    pnl.getCell(2, col).value = { formula: `Assumptions!B1*${growth[i]}`, result: rev };
    pnl.getCell(3, col).value = { formula: `${revCol}2*Assumptions!B2`, result: costs };
    pnl.getCell(4, col).value = { formula: `${revCol}2-${revCol}3`, result: gp };
    pnl.getCell(5, col).value = { formula: `${revCol}4/${revCol}2`, result: margin };
    cached.push({ period: periods[i], revenue: rev, costs, gross_profit: gp, gross_margin: margin });
  }

  return { buffer: Buffer.from(await wb.xlsx.writeBuffer()), cached };
}

const QUARTERLY_SCHEMA = {
  scenarioLevers: [
    { id: "revenue_base", label: "Revenue Base", sheet: "Assumptions", cell: "B1", scenarios: { base: 1000 } },
    { id: "cost_ratio", label: "Cost Ratio", sheet: "Assumptions", cell: "B2", scenarios: { base: 0.6 } },
  ],
  outputMetrics: [
    { id: "revenue", label: "Revenue", sheet: "P&L", cell: "B2", row: 2 },
    { id: "costs", label: "Costs", sheet: "P&L", cell: "B3", row: 3 },
    { id: "gross_profit", label: "Gross Profit", sheet: "P&L", cell: "B4", row: 4 },
    { id: "gross_margin", label: "Gross Margin", sheet: "P&L", cell: "B5", row: 5 },
  ],
};

test("xlsx: quarterly evaluatePeriods matches Excel cached Q1–Q4 results", async () => {
  const { buffer, cached } = await buildQuarterlyWorkbook();
  const graph = await extractWorkbookGraph(buffer);
  assert.ok(graph.timeAxis, "time axis should detect Q1–Q4");
  assert.ok(
    (graph.timeAxis!.columns || []).some((c) => /Q1/i.test(c)),
    `expected Q1 in time axis, got ${graph.timeAxis!.columns.join(",")}`,
  );

  const build = XlsxModelRuntime.build(graph, QUARTERLY_SCHEMA);
  assert.ok(build.ok && build.runtime, build.errors.join("; "));
  assert.ok(build.runtime!.supportsPeriods, "runtime should support multi-period");

  const slices = build.runtime!.evaluatePeriods({});
  assert.strictEqual(slices.length, 4, `expected 4 periods, got ${slices.map((s) => s.period).join(",")}`);

  for (let i = 0; i < 4; i++) {
    const s = slices[i];
    const e = cached[i];
    assert.ok(/Q[1-4]/i.test(s.period), `period label ${s.period}`);
    assert.ok(Math.abs(s.values.revenue - e.revenue) < 1e-6, `Q${i + 1} revenue ${s.values.revenue} vs ${e.revenue}`);
    assert.ok(Math.abs(s.values.costs - e.costs) < 1e-6, `Q${i + 1} costs`);
    assert.ok(Math.abs(s.values.gross_profit - e.gross_profit) < 1e-6, `Q${i + 1} GP`);
    assert.ok(Math.abs(s.values.gross_margin - e.gross_margin) < 1e-9, `Q${i + 1} margin`);
  }

  // Lever override propagates across all period columns
  const up = build.runtime!.evaluatePeriods({ revenue_base: 2000 });
  assert.ok(Math.abs(up[0].values.revenue - 2000) < 1e-6);
  assert.ok(Math.abs(up[3].values.revenue - 2300) < 1e-6);
});

test("xlsx: multi-period aggregate is ratio-aware (margin not summed)", async () => {
  const { aggregateXlsxPeriodPl } = await import("./simulationAggregation.js");
  const periods = [
    { period: "Q1", pl: { revenue: 1000, costs: 600, gross_profit: 400, gross_margin: 0.4 }, variables: {} },
    { period: "Q2", pl: { revenue: 2000, costs: 1200, gross_profit: 800, gross_margin: 0.4 }, variables: {} },
  ];
  const { aggregate } = aggregateXlsxPeriodPl(periods, ["revenue", "costs", "gross_profit", "gross_margin"]);
  assert.strictEqual(aggregate.revenue, 3000);
  assert.strictEqual(aggregate.costs, 1800);
  assert.strictEqual(aggregate.gross_profit, 1200);
  assert.ok(Math.abs(aggregate.gross_margin - 0.4) < 1e-9, `margin should stay 0.4 not 0.8, got ${aggregate.gross_margin}`);
});

// ── Seeded RNG ──

test("random: same seed reproduces the exact sequence", () => {
  const a = mulberry32(12345);
  const b = mulberry32(12345);
  for (let i = 0; i < 100; i++) assert.strictEqual(a(), b());
});

test("random: lognormal never negative, PERT respects bounds", () => {
  const rng = mulberry32(42);
  for (let i = 0; i < 2000; i++) {
    assert.ok(lognormalRandom(rng, 100, 30) > 0);
    const p = pertRandom(rng, 50, 100, 200);
    assert.ok(p >= 50 && p <= 200);
  }
});

test("random: normal01 has ~0 mean and ~1 stddev", () => {
  const rng = mulberry32(7);
  const n = 20000;
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const z = normal01(rng);
    sum += z;
    sumSq += z * z;
  }
  const mean = sum / n;
  const sd = Math.sqrt(sumSq / n - mean * mean);
  assert.ok(Math.abs(mean) < 0.03, `mean ${mean}`);
  assert.ok(Math.abs(sd - 1) < 0.03, `sd ${sd}`);
});

test("random: cholesky produces target correlation, rejects non-PD", () => {
  const L = cholesky([[1, 0.8], [0.8, 1]]);
  const rng = mulberry32(99);
  const n = 20000;
  let sumXY = 0;
  for (let i = 0; i < n; i++) {
    const z1 = normal01(rng);
    const z2 = normal01(rng);
    const x = L[0][0] * z1;
    const y = L[1][0] * z1 + L[1][1] * z2;
    sumXY += x * y;
  }
  const rho = sumXY / n; // both standard normal → E[xy] = correlation
  assert.ok(Math.abs(rho - 0.8) < 0.05, `sample correlation ${rho}`);

  assert.throws(() => cholesky([[1, 0.9, 0.9], [0.9, 1, -0.9], [0.9, -0.9, 1]]));
});

// ── parseNumericLike: accounting negatives + scale suffixes ──

test("parseNumericLike: accounting negatives", () => {
  assert.strictEqual(parseNumericLike("(1,234)"), -1234);
  assert.strictEqual(parseNumericLike("(1,234.56)"), -1234.56);
  assert.strictEqual(parseNumericLike("$(500)"), -500);
});

test("parseNumericLike: scale suffixes", () => {
  assert.strictEqual(parseNumericLike("1.2M"), 1_200_000);
  assert.strictEqual(parseNumericLike("500k"), 500_000);
  assert.strictEqual(parseNumericLike("3.4bn"), 3_400_000_000);
  assert.strictEqual(parseNumericLike("2.5Cr"), 25_000_000);
  assert.strictEqual(parseNumericLike("1.5L"), 150_000);
  assert.strictEqual(parseNumericLike("(1.2M)"), -1_200_000);
});

test("parseNumericLike: plain numbers, percents, commas still work", () => {
  assert.strictEqual(parseNumericLike(42), 42);
  assert.strictEqual(parseNumericLike("1,234.56"), 1234.56);
  assert.strictEqual(parseNumericLike("-8%"), -0.08);
  assert.strictEqual(parseNumericLike("not a number"), null);
  assert.strictEqual(parseNumericLike(""), null);
});

// ── CSV parsing: quoted commas, multi-line cells (was raw text dump) ──

test("csv: quoted fields containing commas are not split", () => {
  const csv = 'name,revenue,notes\n"Acme, Inc.",1000,"stable"\n"Beta Corp",2000,"growing, fast"\n';
  const text = extractCsvText(Buffer.from(csv, "utf-8"));
  const lines = text.split("\n");
  assert.strictEqual(lines.length, 3);
  assert.ok(lines[1].includes("Acme, Inc."), "quoted comma preserved as one field");
  assert.ok(lines[2].includes("growing, fast"));
});

test("csv: multi-line quoted cell stays one record", () => {
  const csv = 'name,description\n"Acme","Line one\nLine two"\n';
  const text = extractCsvText(Buffer.from(csv, "utf-8"));
  const rows = text.split("\n").filter((l) => l.startsWith("Row"));
  assert.strictEqual(rows.length, 2, "header + one data row, not split on the embedded newline");
});
