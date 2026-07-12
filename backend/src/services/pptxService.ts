import PptxGenJSModule from "pptxgenjs";
// Handle ESM/CJS interop: tsx may wrap the module
const PptxGenJS = (PptxGenJSModule as unknown as { default?: typeof PptxGenJSModule }).default ?? PptxGenJSModule;
type PptxTableRow = Array<{ text: string; options?: Record<string, unknown> }>;
type PptxTableCell = { text: string; options?: Record<string, unknown> };
import { pool } from "../db/index.js";
import { computeBaseCase, getModelDefinition, getPLMetrics } from "../models/registry.js";
import { resolveBasePl } from "./basePl.js";

interface PeriodBreakdown {
  period: string;
  pl: Record<string, number>;
}

// Deloitte brand colors
const DELOITTE = {
  green: "86BC25",
  black: "1D1D1B",
  charcoal: "2D2D2D",
  white: "FFFFFF",
  gray: "97999B",
  grayLight: "D0D0CE",
  red: "DA291C",
  blue: "007CB0",
};

function metricLabel(id: string): string {
  return id.split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

function fmtNum(n: number): string {
  return "$" + Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 0 });
}

export async function exportToPptx(scenarioId: string): Promise<Buffer> {
  // Fetch data
  const sRes = await pool.query("SELECT scenario_id, name, nl_input FROM scenarios WHERE scenario_id = $1", [scenarioId]);
  if (sRes.rows.length === 0) throw new Error("Scenario not found");
  const scenario = sRes.rows[0];

  const oRes = await pool.query(
    "SELECT output_data, narrative_summary FROM scenario_outputs WHERE scenario_id = $1 AND output_type = 'pl' ORDER BY created_at DESC LIMIT 1",
    [scenarioId]
  );
  const rawOutput = oRes.rows[0]?.output_data ?? {};
  const pl = rawOutput.aggregate ?? rawOutput;
  const periods: PeriodBreakdown[] = rawOutput.periods ?? [];
  const narrative = oRes.rows[0]?.narrative_summary ?? null;

  const pRes = await pool.query(
    "SELECT extracted_name, scenario_value, status FROM scenario_parameters WHERE scenario_id = $1 ORDER BY created_at",
    [scenarioId]
  );
  const params = pRes.rows;

  const sModelRef = await pool.query("SELECT model_version_hash FROM scenarios WHERE scenario_id = $1", [scenarioId]);
  const modelHash = sModelRef.rows[0]?.model_version_hash;
  const model = await getModelDefinition(modelHash);
  const baseValues = await resolveBasePl(rawOutput, model);
  const plMetrics = model
    ? getPLMetrics(model)
    : [...new Set([...Object.keys(pl), ...Object.keys(baseValues)])];
  if (model && Object.keys(baseValues).length === 0) {
    Object.assign(baseValues, await computeBaseCase(model));
  }
  const periodCount = periods.length || 1;

  // Create presentation
  const pptx = new (PptxGenJS as any)();
  pptx.author = "Scenario Modeling | Deloitte";
  pptx.company = "Deloitte";
  pptx.title = scenario.name || "Scenario Analysis";
  pptx.layout = "LAYOUT_WIDE";

  // ── Slide 1: Title ──
  const titleSlide = pptx.addSlide();
  titleSlide.background = { color: DELOITTE.black };
  titleSlide.addText("Scenario Modeling Report", {
    x: 0.8, y: 1.5, w: 10, h: 1.2,
    fontSize: 36, fontFace: "Arial",
    color: DELOITTE.white, bold: true,
  });
  titleSlide.addText(scenario.name || "Untitled Scenario", {
    x: 0.8, y: 2.8, w: 10, h: 0.8,
    fontSize: 20, fontFace: "Arial",
    color: DELOITTE.green,
  });
  titleSlide.addText(scenario.nl_input, {
    x: 0.8, y: 3.8, w: 10, h: 0.6,
    fontSize: 12, fontFace: "Arial",
    color: DELOITTE.gray, italic: true,
  });
  // Green bar at bottom
  titleSlide.addShape(pptx.ShapeType.rect, {
    x: 0, y: 6.8, w: 13.33, h: 0.15,
    fill: { color: DELOITTE.green },
  });

  // ── Slide 2: P&L Summary ──
  const plSlide = pptx.addSlide();
  plSlide.addText("P&L Impact Summary", {
    x: 0.5, y: 0.3, w: 8, h: 0.6,
    fontSize: 22, fontFace: "Arial",
    color: DELOITTE.black, bold: true,
  });
  // Green underline
  plSlide.addShape(pptx.ShapeType.rect, {
    x: 0.5, y: 0.85, w: 2.5, h: 0.04,
    fill: { color: DELOITTE.green },
  });

  // P&L table
  const plRows: PptxTableRow[] = [];
  // Header
  plRows.push([
    { text: "Metric", options: { bold: true, color: DELOITTE.white, fill: { color: DELOITTE.charcoal }, fontSize: 11, fontFace: "Arial" } },
    { text: "Base", options: { bold: true, color: DELOITTE.white, fill: { color: DELOITTE.charcoal }, fontSize: 11, fontFace: "Arial", align: "right" } },
    { text: "Scenario", options: { bold: true, color: DELOITTE.white, fill: { color: DELOITTE.charcoal }, fontSize: 11, fontFace: "Arial", align: "right" } },
    { text: "Delta", options: { bold: true, color: DELOITTE.white, fill: { color: DELOITTE.charcoal }, fontSize: 11, fontFace: "Arial", align: "right" } },
    { text: "Delta %", options: { bold: true, color: DELOITTE.white, fill: { color: DELOITTE.charcoal }, fontSize: 11, fontFace: "Arial", align: "right" } },
  ]);

  for (const key of plMetrics) {
    const base = Math.round((baseValues[key] ?? 0) * periodCount * 100) / 100;
    const scenVal = pl[key] ?? 0;
    const delta = Math.round((scenVal - base) * 100) / 100;
    const deltaPct = base !== 0 ? Math.round((delta / base) * 10000) / 100 : 0;
    const deltaColor = delta >= 0 ? DELOITTE.green : DELOITTE.red;

    plRows.push([
      { text: metricLabel(key), options: { fontSize: 10, fontFace: "Arial", bold: true } },
      { text: fmtNum(base), options: { fontSize: 10, fontFace: "Arial", align: "right" } },
      { text: fmtNum(scenVal), options: { fontSize: 10, fontFace: "Arial", align: "right", bold: true } },
      { text: `${delta >= 0 ? "+" : "-"}${fmtNum(delta)}`, options: { fontSize: 10, fontFace: "Arial", align: "right", color: deltaColor, bold: true } },
      { text: `${deltaPct >= 0 ? "+" : ""}${deltaPct}%`, options: { fontSize: 10, fontFace: "Arial", align: "right", color: deltaColor } },
    ]);
  }

  plSlide.addTable(plRows, {
    x: 0.5, y: 1.2, w: 10,
    border: { pt: 0.5, color: DELOITTE.grayLight },
    colW: [2.5, 1.8, 1.8, 1.8, 1.3],
    rowH: 0.4,
  });

  // ── Slide 3: Period Breakdown (if multi-period) ──
  if (periods.length > 1) {
    const periodSlide = pptx.addSlide();
    periodSlide.addText("Period Breakdown", {
      x: 0.5, y: 0.3, w: 8, h: 0.6,
      fontSize: 22, fontFace: "Arial",
      color: DELOITTE.black, bold: true,
    });
    periodSlide.addShape(pptx.ShapeType.rect, {
      x: 0.5, y: 0.85, w: 2.5, h: 0.04,
      fill: { color: DELOITTE.green },
    });

    const pRows: PptxTableRow[] = [];
    // Header
    const headerCells: PptxTableCell[] = [
      { text: "Metric", options: { bold: true, color: DELOITTE.white, fill: { color: DELOITTE.charcoal }, fontSize: 9, fontFace: "Arial" } },
    ];
    for (const p of periods) {
      headerCells.push({ text: p.period, options: { bold: true, color: DELOITTE.white, fill: { color: DELOITTE.charcoal }, fontSize: 9, fontFace: "Arial", align: "center" } });
    }
    headerCells.push({ text: "Total", options: { bold: true, color: DELOITTE.white, fill: { color: DELOITTE.green }, fontSize: 9, fontFace: "Arial", align: "right" } });
    pRows.push(headerCells);

    for (const key of plMetrics) {
      const cells: PptxTableCell[] = [
        { text: metricLabel(key), options: { fontSize: 9, fontFace: "Arial", bold: true } },
      ];
      let total = 0;
      for (const p of periods) {
        const val = p.pl[key] ?? 0;
        total += val;
        cells.push({ text: fmtNum(val), options: { fontSize: 9, fontFace: "Arial", align: "center" } });
      }
      cells.push({ text: fmtNum(total), options: { fontSize: 9, fontFace: "Arial", align: "right", bold: true } });
      pRows.push(cells);
    }

    const colWidths = [2, ...periods.map(() => (10 - 2 - 1.5) / periods.length), 1.5];
    periodSlide.addTable(pRows, {
      x: 0.5, y: 1.2, w: 12,
      border: { pt: 0.5, color: DELOITTE.grayLight },
      colW: colWidths,
      rowH: 0.35,
    });
  }

  // ── Slide 4: Key Assumptions ──
  if (params.length > 0) {
    const paramSlide = pptx.addSlide();
    paramSlide.addText("Key Assumptions", {
      x: 0.5, y: 0.3, w: 8, h: 0.6,
      fontSize: 22, fontFace: "Arial",
      color: DELOITTE.black, bold: true,
    });
    paramSlide.addShape(pptx.ShapeType.rect, {
      x: 0.5, y: 0.85, w: 2.5, h: 0.04,
      fill: { color: DELOITTE.green },
    });

    const aRows: PptxTableRow[] = [];
    aRows.push([
      { text: "Parameter", options: { bold: true, color: DELOITTE.white, fill: { color: DELOITTE.charcoal }, fontSize: 11, fontFace: "Arial" } },
      { text: "Value", options: { bold: true, color: DELOITTE.white, fill: { color: DELOITTE.charcoal }, fontSize: 11, fontFace: "Arial", align: "right" } },
      { text: "Status", options: { bold: true, color: DELOITTE.white, fill: { color: DELOITTE.charcoal }, fontSize: 11, fontFace: "Arial", align: "center" } },
    ]);

    for (const p of params) {
      const statusColor = p.status === "accepted" ? DELOITTE.green : p.status === "rejected" ? DELOITTE.red : DELOITTE.gray;
      aRows.push([
        { text: p.extracted_name, options: { fontSize: 10, fontFace: "Arial" } },
        { text: String(p.scenario_value), options: { fontSize: 10, fontFace: "Arial", align: "right" } },
        { text: p.status, options: { fontSize: 10, fontFace: "Arial", align: "center", color: statusColor } },
      ]);
    }

    paramSlide.addTable(aRows, {
      x: 0.5, y: 1.2, w: 8,
      border: { pt: 0.5, color: DELOITTE.grayLight },
      colW: [4, 2, 2],
      rowH: 0.4,
    });
  }

  // ── Slide 5: Executive Summary (if narrative exists) ──
  if (narrative) {
    const narSlide = pptx.addSlide();
    narSlide.addText("Executive Summary", {
      x: 0.5, y: 0.3, w: 8, h: 0.6,
      fontSize: 22, fontFace: "Arial",
      color: DELOITTE.black, bold: true,
    });
    narSlide.addShape(pptx.ShapeType.rect, {
      x: 0.5, y: 0.85, w: 2.5, h: 0.04,
      fill: { color: DELOITTE.green },
    });
    narSlide.addText(narrative, {
      x: 0.5, y: 1.3, w: 11, h: 4.5,
      fontSize: 12, fontFace: "Arial",
      color: DELOITTE.charcoal,
      lineSpacing: 20,
      valign: "top",
    });
  }

  // ── Closing slide ──
  const closeSlide = pptx.addSlide();
  closeSlide.background = { color: DELOITTE.green };
  closeSlide.addText("Thank you", {
    x: 0.8, y: 2.5, w: 10, h: 1.2,
    fontSize: 42, fontFace: "Arial",
    color: DELOITTE.white, bold: true,
  });
  closeSlide.addText("Generated by Scenario Modeling | Deloitte", {
    x: 0.8, y: 3.8, w: 10, h: 0.5,
    fontSize: 12, fontFace: "Arial",
    color: DELOITTE.white,
  });
  closeSlide.addText("AI-generated draft \u2014 review required", {
    x: 0.8, y: 4.4, w: 10, h: 0.5,
    fontSize: 10, fontFace: "Arial",
    color: DELOITTE.white, italic: true,
  });

  const buffer = await pptx.write({ outputType: "nodebuffer" });
  return Buffer.from(buffer as ArrayBuffer);
}
