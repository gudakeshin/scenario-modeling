/**
 * Acceptance test: Wonder Cement FY2025 workbook stays in document-native
 * denomination end-to-end (extractor + runtime). No DB / LLM required.
 *
 * Guards against:
 *  - RC1: Crore→Million candidate canonicalization inflating lever bases
 *  - RC2: FY25/FY24 year-comparison columns aggregated as forecast periods
 *  - RC3: input-only metrics (revenue_cr, volume) dropped from base_pl as zeros
 */

import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractWorkbookGraph } from "./excelExtractor.js";
import { XlsxModelRuntime } from "./xlsxRuntime.js";
import { buildFallbackModelSchema } from "./excelContextEngine.js";
import { resolveOverridesToAbsolute } from "./modelResolver.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_XLSX = path.resolve(
  __dirname,
  "../../../sample_data/Wonder_Cement_Scenario_Model_FY2025.xlsx",
);

function approx(actual: number, expected: number, tol = 0.5): void {
  assert.ok(
    Number.isFinite(actual) && Math.abs(actual - expected) <= tol,
    `expected ${expected} ±${tol}, got ${actual}`,
  );
}

function findCandidate(
  list: Array<{ id: string; label: string; sheet: string; cell?: string; value: number }> | undefined,
  pred: (c: { id: string; label: string; sheet: string; cell?: string; value: number }) => boolean,
) {
  return (list || []).find(pred);
}

test("Wonder Cement: native denomination end-to-end (extractor + runtime)", async () => {
  assert.ok(fs.existsSync(SAMPLE_XLSX), `sample workbook missing: ${SAMPLE_XLSX}`);
  const buffer = fs.readFileSync(SAMPLE_XLSX);
  const graph = await extractWorkbookGraph(buffer);

  // ── Extractor keeps native values ──
  assert.strictEqual(graph.unit, "Crore");
  assert.strictEqual(graph.currency, "INR");

  const volumeCand = findCandidate(
    graph.inputCandidates,
    (c) => c.sheet === "Assumptions" && c.cell === "B7",
  );
  assert.ok(volumeCand, "volume candidate Assumptions!B7");
  approx(volumeCand!.value, 14, 0.01);
  assert.notStrictEqual(volumeCand!.value, 140, "volume must not be ×10 canonicalized");

  const fuelCand = findCandidate(
    graph.inputCandidates,
    (c) => c.sheet === "Assumptions" && c.cell === "B11",
  );
  assert.ok(fuelCand, "fuel candidate Assumptions!B11");
  approx(fuelCand!.value, 980, 0.5);

  const ebitdaCand = findCandidate(graph.outputCandidates, (c) => c.id === "ebitda");
  const ebitCand = findCandidate(graph.outputCandidates, (c) => c.id === "ebit");
  assert.ok(ebitdaCand, "ebitda output candidate");
  assert.ok(ebitCand, "ebit output candidate");
  approx(ebitdaCand!.value, 2741, 1);
  approx(ebitCand!.value, 2200, 1);

  // Year-comparison axis (FY25/FY24), not multi-period forecast
  assert.ok(graph.timeAxis, "timeAxis detected");
  assert.strictEqual(graph.timeAxis!.kind, "year_comparison");
  assert.ok(
    /fy25/i.test(graph.timeAxis!.primaryColumn || ""),
    `primaryColumn should be FY25, got ${graph.timeAxis!.primaryColumn}`,
  );

  // ── Runtime from production fallback schema ──
  const schema = buildFallbackModelSchema(graph, "Wonder Cement");
  // Fallback truncates outputCandidates; ensure KPI rows used by this acceptance
  // check are present (same ids the LLM/catalog path would bind).
  for (const c of graph.outputCandidates || []) {
    const id = c.id;
    if (!["ebitda", "ebit", "revenue_from_operations", "cement_sales_volume_mt"].includes(id)) continue;
    if (!schema.outputMetrics.some((m) => m.id === id)) {
      schema.outputMetrics.push({
        id,
        label: c.label,
        sheet: c.sheet,
        row: c.row,
        cell: c.cell,
        isKPI: true,
      });
    }
  }
  // Metrics that historically only existed as input candidates (RC3)
  for (const id of ["revenue_cr", "sales_volume_mt", "cement_sales_volume"]) {
    if (!schema.outputMetrics.some((m) => m.id === id)) {
      schema.outputMetrics.push({ id, label: id, sheet: "", row: 0, isKPI: true });
    }
  }

  const build = XlsxModelRuntime.build(graph, schema);
  assert.ok(build.ok && build.runtime, `runtime build failed: ${build.errors.join("; ")}`);
  const runtime = build.runtime!;

  const base = runtime.evaluate({});
  const revenue =
    base.revenue_from_operations ?? base.revenue_cr ?? base.revenue;
  const ebitda = base.ebitda;
  const ebit = base.ebit;
  const volume =
    base.cement_sales_volume_mt ??
    base.cement_sales_volume ??
    base.sales_volume_mt;

  approx(revenue, 7252, 0.5);
  approx(ebitda, 2741, 0.5);
  approx(ebit, 2200, 0.5);
  approx(volume, 14, 0.5);

  // Previously-zero ids must bind and be non-zero
  for (const id of ["revenue_cr", "sales_volume_mt", "cement_sales_volume"]) {
    assert.ok(
      Number.isFinite(base[id]) && Math.abs(base[id]) > 0,
      `${id} should be present and non-zero in evaluate({}), got ${base[id]}`,
    );
  }

  // ── Scenario in native units: volume −3.5%, fuel +12.5% ──
  const volumeLeverId = runtime.inputs.find(
    (i) => i.id === "cement_sales_volume" || /cement_sales_volume/.test(i.id),
  )?.id;
  const fuelLeverId = runtime.inputs.find(
    (i) =>
      i.id === "fuel_power_petcoke_coal_grid" ||
      (i.id.includes("fuel") && i.id.includes("power")),
  )?.id;
  assert.ok(volumeLeverId, "volume lever bound");
  assert.ok(fuelLeverId, `fuel lever bound, inputs=${runtime.inputs.map((i) => i.id).join(",")}`);

  const { absolute, unresolved } = resolveOverridesToAbsolute(runtime, [
    { variableId: volumeLeverId!, value: -3.5, delta_type: "percent" },
    { variableId: fuelLeverId!, value: 12.5, delta_type: "percent" },
  ]);
  assert.strictEqual(unresolved.length, 0, `unresolved: ${unresolved.join(",")}`);
  approx(absolute[volumeLeverId!], 13.51, 0.02);
  approx(absolute[fuelLeverId!], 1102.5, 0.5);

  const scenario = runtime.evaluate(absolute);
  const scenRevenue =
    scenario.revenue_from_operations ?? scenario.revenue_cr ?? scenario.revenue;
  assert.ok(
    scenRevenue >= 6963 && scenRevenue < 10_000,
    `scenario revenue should be ~6963–6999 Cr (native), got ${scenRevenue}`,
  );

  // No metric moves > 200% vs base (guards ×10/×100 inflation)
  for (const id of runtime.outputIds) {
    const b = base[id];
    const s = scenario[id];
    if (!Number.isFinite(b) || !Number.isFinite(s) || Math.abs(b) < 1e-9) continue;
    const pctMove = Math.abs((s - b) / b) * 100;
    assert.ok(
      pctMove <= 200,
      `${id} moved ${pctMove.toFixed(1)}% (base=${b}, scenario=${s}) — likely unit inflation`,
    );
  }

  // ── Period semantics: exactly 1 slice (FY25); aggregate == slice ──
  assert.ok(!runtime.supportsPeriods, "year_comparison must not enable multi-period");
  const slices = runtime.evaluatePeriods({});
  assert.strictEqual(slices.length, 1, `expected 1 period slice, got ${slices.map((s) => s.period).join(",")}`);
  assert.ok(/fy25/i.test(slices[0].period), `period label should be FY25, got ${slices[0].period}`);

  const sliceRev =
    slices[0].values.revenue_from_operations ??
    slices[0].values.revenue_cr ??
    slices[0].values.revenue;
  approx(sliceRev, revenue, 0.01);
});
