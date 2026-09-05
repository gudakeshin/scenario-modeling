/**
 * Regression fixture: the monthly Royal Enfield scenario model.
 *
 * This workbook is the one that produced a confident, wrong answer. It has
 * every shape the old pipeline mishandled at once:
 *  - two assumption blocks reusing the same row labels (Bullet/Classic/…)
 *  - a Base|Bull|Bear|Active band whose Active column drives the model
 *  - an actuals sheet on FY23 months preceding a P&L on FY24 months
 *  - a P&L whose annual figure lives in its own "FY24 Total" column
 *  - reference sheets of GL codes and part numbers
 *  - a corrupt volume cell that inflates one month by ~50x
 *
 * No DB or LLM required.
 */

import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractWorkbookArtifact, extractWorkbookGraph } from "./excelExtractor.js";
import { XlsxModelRuntime } from "./xlsxRuntime.js";
import { buildFallbackModelSchema } from "./excelContextEngine.js";
import { detectPeriodOutliers } from "./simulationAggregation.js";
import { analyzeWorkbookDataQuality, inertAssumptionFindings } from "./dataQuality.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_XLSX = path.resolve(
  __dirname,
  "../../../sample_data/RE_Scenario_Model_FY2024.xlsx",
);

test("Royal Enfield: bindings, calendar and economics are all sound", async () => {
  assert.ok(fs.existsSync(SAMPLE_XLSX), `sample workbook missing: ${SAMPLE_XLSX}`);
  const graph = await extractWorkbookGraph(fs.readFileSync(SAMPLE_XLSX));

  // ── Lever identity ──
  const inputs = graph.inputCandidates || [];
  const ids = inputs.map((c) => c.id);
  assert.strictEqual(new Set(ids).size, ids.length, `duplicate lever ids: ${ids.join(", ")}`);
  assert.strictEqual(
    inputs.filter((c) => c.isFormula).length,
    0,
    "no computed cell may be offered as a lever",
  );

  // The two blocks that previously collapsed onto one id.
  const volumeBullet = inputs.find((c) => c.sheet === "Assumptions" && c.cell === "B8");
  const priceBullet = inputs.find((c) => c.sheet === "Assumptions" && c.cell === "B16");
  assert.ok(volumeBullet && priceBullet, "both Bullet rows present");
  assert.notStrictEqual(volumeBullet!.id, priceBullet!.id);
  assert.strictEqual(volumeBullet!.value, 0.06);
  assert.strictEqual(priceBullet!.value, 0.02);
  // Each carries the Active-column twin the P&L actually reads.
  assert.strictEqual(volumeBullet!.activeCell, "E8");
  assert.strictEqual(priceBullet!.activeCell, "E16");

  // ── Reference sheets contribute no levers ──
  for (const sheet of ["GL_Reference", "Product_Master"]) {
    assert.strictEqual(
      graph.sheets[sheet]?.referenceOnly,
      true,
      `${sheet} should be reference-only`,
    );
    assert.strictEqual(
      inputs.filter((c) => c.sheet === sheet).length,
      0,
      `${sheet} must not contribute levers`,
    );
  }
  // …but the NSP price list must survive: those are real levers.
  assert.ok(
    inputs.some((c) => c.sheet === "Price_NSP"),
    "price list must remain available as levers",
  );

  // ── Calendar ──
  assert.strictEqual(graph.timeAxis?.sheet, "P&L", "axis follows the P&L, not Volume_Plan");
  assert.ok(graph.timeAxis!.columns.includes("Apr-24"));
  assert.ok(
    !graph.timeAxis!.columns.includes("Apr-23"),
    "FY23 actuals columns must not label FY24 plan periods",
  );
  assert.strictEqual(graph.timeAxis!.aggregateCol, "FY24 Total");
  assert.strictEqual(graph.scenarioToggle?.cell, "Assumptions!B4");

  // ── Runtime ──
  const build = XlsxModelRuntime.build(graph, buildFallbackModelSchema(graph, "Royal Enfield"));
  assert.ok(build.ok && build.runtime, `build failed: ${build.errors.join("; ")}`);
  const runtime = build.runtime!;
  assert.strictEqual(
    new Set(build.boundLevers).size,
    build.boundLevers.length,
    "bound levers must be unique",
  );

  const periods = runtime.evaluatePeriods({});
  assert.strictEqual(periods.length, 12, "twelve months, with the total column excluded");
  assert.deepStrictEqual(
    [periods[0].period, periods[11].period],
    ["Apr-24", "Mar-25"],
    "period labels span the plan year",
  );

  // Headline reads the workbook's own FY total (P&L!O4 = SUM(C4:N4)), not April.
  const base = runtime.evaluate({});
  const aprilRevenue = periods[0].values.gross_revenue;
  assert.ok(
    base.gross_revenue > aprilRevenue * 2,
    `headline revenue ${base.gross_revenue} must not be a single month (${aprilRevenue})`,
  );
  const periodSum = periods.reduce((acc, p) => acc + (p.values.gross_revenue ?? 0), 0);
  assert.ok(
    Math.abs(base.gross_revenue - periodSum) / periodSum < 0.001,
    `FY total ${base.gross_revenue} should tie to the sum of months ${periodSum}`,
  );

  // ── Economics of a raw-material shock ──
  const materialCost = runtime.inputs.find((i) => i.id === "material_cost_of_nsp");
  assert.ok(materialCost, "material cost lever bound");
  assert.strictEqual(materialCost!.base, 0.6);

  const scenario = runtime.evaluate({ material_cost_of_nsp: materialCost!.base * 1.075 });
  const pct = (id: string) => ((scenario[id] - base[id]) / Math.abs(base[id])) * 100;

  assert.ok(Math.abs(pct("gross_revenue")) < 1e-6, "holding NSP leaves revenue unchanged");
  assert.ok(Math.abs(pct("material_vehicle_cost") - 7.5) < 0.01, "COGS moves with the lever");
  assert.ok(pct("gross_profit") < -10, `gross profit must fall, got ${pct("gross_profit")}%`);
  assert.ok(pct("ebitda") < -10, `EBITDA must fall, got ${pct("ebitda")}%`);
  // The margin stays the workbook's own fraction — never rescaled to a percent.
  assert.ok(
    base.ebitda_margin > 0 && base.ebitda_margin < 1,
    `margin should be a fraction, got ${base.ebitda_margin}`,
  );
  assert.ok(scenario.ebitda_margin < base.ebitda_margin, "margin compresses");

  // ── The corrupt month is surfaced, not absorbed into the annual total ──
  const outlierNotices = detectPeriodOutliers(
    periods.map((p) => ({ period: p.period, pl: p.values })),
    runtime.outputIds,
  );
  assert.ok(
    outlierNotices.some((n) => n.includes("gross_revenue") && n.includes("May-24")),
    `expected a May-24 revenue outlier notice, got: ${outlierNotices.join(" | ")}`,
  );
});

test("Royal Enfield: overrides that move nothing are reported", async () => {
  const graph = await extractWorkbookGraph(fs.readFileSync(SAMPLE_XLSX));
  const runtime = XlsxModelRuntime.build(
    graph,
    buildFallbackModelSchema(graph, "Royal Enfield"),
  ).runtime!;

  // Assumptions!B25 is a marketing-spend ratio the P&L never reads — it pulls
  // the IO-level total from Mktng_Cost instead. Overriding it is a no-op, and
  // the run has to say so rather than reporting an unchanged metric as success.
  const inert = runtime.findInertOverrides({ marketing_spend_of_revenue: 0.2 });
  assert.deepStrictEqual(
    inert.map((i) => i.id),
    ["marketing_spend_of_revenue"],
  );

  // A lever that is wired through reports nothing.
  const materialCost = runtime.inputs.find((i) => i.id === "material_cost_of_nsp")!;
  assert.deepStrictEqual(
    runtime.findInertOverrides({ material_cost_of_nsp: materialCost.base * 1.075 }),
    [],
  );
});

test("Royal Enfield: data quality reports the root causes, not the echoes", async () => {
  const artifact = await extractWorkbookArtifact(fs.readFileSync(SAMPLE_XLSX));
  const findings = analyzeWorkbookDataQuality(artifact.graph, artifact.snapshot);

  // The corrupt Bullet volumes reach twelve calculated lines. Reporting each of
  // them buries the one cell an analyst can actually act on.
  const outliers = findings.filter((f) => f.code === "period_outlier");
  assert.strictEqual(
    outliers.length,
    1,
    `expected the single root cause, got: ${outliers.map((f) => `${f.sheet}!${f.cells.join("/")}`).join(", ")}`,
  );
  assert.strictEqual(outliers[0].sheet, "Volume_Plan");
  assert.deepStrictEqual(outliers[0].cells, ["C4", "D4"]);
  assert.strictEqual(outliers[0].severity, "error", "an outlier of this size blocks a run");
  assert.match(outliers[0].message, /flows through to/);

  // FY23 actuals feeding an FY24 plan is worth confirming, not assuming.
  const calendars = findings.filter((f) => f.code === "calendar_mismatch");
  assert.deepStrictEqual(calendars.map((f) => f.sheet), ["Volume_Plan"]);

  // The Revenue sheet's headers ("Apr" … "Mar") state no year, so it is not in
  // conflict with anything and must not be flagged.
  assert.ok(
    !findings.some((f) => f.sheet === "Revenue"),
    "a year-less schedule is consistent, not mismatched",
  );

  // Nothing else should be raised on this workbook.
  assert.deepStrictEqual(
    [...new Set(findings.map((f) => f.code))].sort(),
    ["calendar_mismatch", "period_outlier"],
  );
});

test("Royal Enfield: the dead assumption is reported as a data issue", async () => {
  const graph = await extractWorkbookGraph(fs.readFileSync(SAMPLE_XLSX));
  const build = XlsxModelRuntime.build(graph, buildFallbackModelSchema(graph, "Royal Enfield"));
  const findings = inertAssumptionFindings(build.bindingEvidence);

  // Assumptions!B25 is a marketing-spend ratio the P&L never reads.
  const marketing = findings.find((f) => f.cells.includes("B25"));
  assert.ok(marketing, `expected a finding on Assumptions!B25, got: ${findings.map((f) => f.cells.join("/")).join(", ")}`);
  assert.strictEqual(marketing!.code, "inert_assumption");
  assert.match(marketing!.message, /changes no output metric/);
});
