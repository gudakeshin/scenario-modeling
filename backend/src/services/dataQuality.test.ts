/**
 * Data-quality detection tests.
 *
 * Each case is a shape that produced a confident, wrong answer or an unusable
 * wall of findings. No DB or LLM required.
 */

import test from "node:test";
import assert from "node:assert";
import ExcelJS from "exceljs";
import { extractWorkbookArtifact } from "./excelExtractor.js";
import {
  analyzeWorkbookDataQuality,
  medianOutliers,
  yearOfHeader,
  type DataQualityFinding,
} from "./dataQuality.js";

const MONTHS = [
  "Apr-24", "May-24", "Jun-24", "Jul-24", "Aug-24", "Sep-24",
  "Oct-24", "Nov-24", "Dec-24", "Jan-25", "Feb-25", "Mar-25",
];

/** A formula cell together with the result Excel cached for it. */
type CellSpec = number | string | null | { formula: string; result: number };

interface SheetSpec {
  name: string;
  headers: string[];
  rows: Array<{ label: string; values: CellSpec[] }>;
}

async function workbookOf(sheets: SheetSpec[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  for (const spec of sheets) {
    const ws = wb.addWorksheet(spec.name);
    ws.getCell(1, 1).value = "Label";
    spec.headers.forEach((h, i) => {
      ws.getCell(1, i + 2).value = h;
    });
    spec.rows.forEach((row, r) => {
      ws.getCell(r + 2, 1).value = row.label;
      row.values.forEach((v, i) => {
        if (v == null) return;
        const cell = ws.getCell(r + 2, i + 2);
        if (typeof v === "object") {
          cell.value = { formula: v.formula.replace(/^=/, ""), result: v.result };
        } else if (typeof v === "string" && v.startsWith("=")) {
          cell.value = { formula: v.slice(1), result: 1 };
        } else {
          cell.value = v;
        }
      });
    });
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function findingsOf(sheets: SheetSpec[]): Promise<DataQualityFinding[]> {
  const artifact = await extractWorkbookArtifact(await workbookOf(sheets));
  return analyzeWorkbookDataQuality(artifact.graph, artifact.snapshot);
}

const steadyRow = (label: string) => ({
  label,
  values: MONTHS.map((_, i) => 100 + i),
});

test("a single wild period is reported, naming the cell", async () => {
  const values = MONTHS.map((_, i) => 100 + i);
  values[1] = 50_000; // May, ~500x its neighbours
  const findings = await findingsOf([
    { name: "Plan", headers: MONTHS, rows: [{ label: "Units", values }] },
  ]);

  const outliers = findings.filter((f) => f.code === "period_outlier");
  assert.strictEqual(outliers.length, 1, `expected one outlier, got ${outliers.length}`);
  assert.deepStrictEqual(outliers[0].cells, ["C2"], "names the offending cell");
  assert.strictEqual(outliers[0].severity, "error");
  assert.match(outliers[0].message, /Units/);
  assert.match(outliers[0].message, /50,000|50000/);
});

test("a steady row produces no findings", async () => {
  const findings = await findingsOf([
    { name: "Plan", headers: MONTHS, rows: [steadyRow("Units"), steadyRow("Spares")] },
  ]);
  assert.deepStrictEqual(findings, [], `expected none, got ${findings.map((f) => f.code).join(", ")}`);
});

test("findingKey is stable across re-extraction and changes with the data", async () => {
  const withValue = (spike: number) => {
    const values = MONTHS.map((_, i) => 100 + i);
    values[1] = spike;
    return [{ name: "Plan", headers: MONTHS, rows: [{ label: "Units", values }] }];
  };

  const first = await findingsOf(withValue(50_000));
  const again = await findingsOf(withValue(50_000));
  const changed = await findingsOf(withValue(60_000));

  assert.strictEqual(
    first[0].findingKey,
    again[0].findingKey,
    "unchanged data must keep its key so an acknowledgement survives re-ingestion",
  );
  assert.notStrictEqual(
    first[0].findingKey,
    changed[0].findingKey,
    "a changed value must be reviewed again rather than inheriting a decision",
  );
});

test("a gap inside a populated series is reported", async () => {
  const values: Array<number | null> = MONTHS.map((_, i) => 100 + i);
  values[5] = null;
  const findings = await findingsOf([
    { name: "Plan", headers: MONTHS, rows: [{ label: "Units", values }] },
  ]);
  const gaps = findings.filter((f) => f.code === "series_gap");
  assert.strictEqual(gaps.length, 1);
  assert.deepStrictEqual(gaps[0].cells, ["G2"]);
  assert.match(gaps[0].message, /understates/);
});

test("a literal inside a calculated row is reported as a plug", async () => {
  const values = MONTHS.map((_, i) => (i === 4 ? 999 : "=1+1"));
  const findings = await findingsOf([
    { name: "Plan", headers: MONTHS, rows: [{ label: "Computed", values }] },
  ]);
  const plugs = findings.filter((f) => f.code === "hardcoded_plug");
  assert.strictEqual(plugs.length, 1, `expected one plug, got ${plugs.length}`);
  assert.deepStrictEqual(plugs[0].cells, ["F2"]);
  assert.match(plugs[0].message, /will not respond/);
});

test("a sheet on another year is reported only when both state a year", async () => {
  const priorYear = MONTHS.map((m) => m.replace("-24", "-23").replace("-25", "-24"));
  const unlabelled = ["Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar"];

  const findings = await findingsOf([
    { name: "Actuals", headers: priorYear, rows: [steadyRow("Units")] },
    { name: "Schedule", headers: unlabelled, rows: [steadyRow("Units")] },
    { name: "P&L Summary", headers: MONTHS, rows: [steadyRow("Revenue")] },
  ]);

  const mismatches = findings.filter((f) => f.code === "calendar_mismatch");
  assert.deepStrictEqual(
    mismatches.map((f) => f.sheet),
    ["Actuals"],
    "a year-less schedule is not in conflict with anything and must not be flagged",
  );
  assert.match(mismatches[0].message, /2023/);
});

test("downstream echoes collapse onto the root cause", async () => {
  // One corrupt input, quoted by a chain of calculated rows. Reporting each of
  // them buries the single cell a human can act on.
  const sourceValue = (i: number) => (i === 1 ? 50_000 : 100 + i);
  const corrupt = MONTHS.map((_, i) => sourceValue(i));
  // Cached results carry the corruption forward, so each derived row would be
  // flagged on its own were it not recognised as an echo.
  const derived = MONTHS.map((_, i) => ({
    formula: `=Source!${String.fromCharCode(66 + i)}2*2`,
    result: sourceValue(i) * 2,
  }));
  const derivedAgain = MONTHS.map((_, i) => ({
    formula: `=Derived!${String.fromCharCode(66 + i)}2+1`,
    result: sourceValue(i) * 2 + 1,
  }));

  const findings = await findingsOf([
    { name: "Source", headers: MONTHS, rows: [{ label: "Units", values: corrupt }] },
    { name: "Derived", headers: MONTHS, rows: [{ label: "Revenue", values: derived }] },
    { name: "P&L Summary", headers: MONTHS, rows: [{ label: "EBITDA", values: derivedAgain }] },
  ]);

  const outliers = findings.filter((f) => f.code === "period_outlier");
  assert.strictEqual(outliers.length, 1, `expected only the root, got ${outliers.map((f) => f.sheet).join(", ")}`);
  assert.strictEqual(outliers[0].sheet, "Source");
  assert.match(outliers[0].message, /flows through to/);
  assert.ok(
    (outliers[0].evidence?.propagatesTo as number) >= 1,
    "the blast radius is recorded on the root",
  );
});

test("medianOutliers needs enough points and ignores a majority", () => {
  assert.strictEqual(medianOutliers([{ label: "a", value: 1 }]), null, "too few points");
  assert.strictEqual(
    medianOutliers([
      { label: "a", value: 1 },
      { label: "b", value: 1000 },
      { label: "c", value: 1000 },
      { label: "d", value: 1000 },
    ]),
    null,
    "when most of the row is 'outlying', the median is the anomaly",
  );
  const hit = medianOutliers([
    { label: "a", value: 100 },
    { label: "b", value: 101 },
    { label: "c", value: 102 },
    { label: "d", value: 99_000 },
  ]);
  assert.deepStrictEqual(hit?.outliers.map((o) => o.label), ["d"]);
});

test("yearOfHeader reads the year only when the header states one", () => {
  assert.strictEqual(yearOfHeader("Apr-24"), 2024);
  assert.strictEqual(yearOfHeader("FY25"), 2025);
  assert.strictEqual(yearOfHeader("FY2025"), 2025);
  assert.strictEqual(yearOfHeader("Apr"), null);
  assert.strictEqual(yearOfHeader("Total"), null);
});
