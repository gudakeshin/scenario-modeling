import PptxGenJSModule from "pptxgenjs";
// Handle ESM/CJS interop: tsx may wrap the module
const PptxGenJS = (PptxGenJSModule as unknown as { default?: typeof PptxGenJSModule }).default ?? PptxGenJSModule;
type PptxTableRow = Array<{ text: string; options?: Record<string, unknown> }>;
type PptxTableCell = { text: string; options?: Record<string, unknown> };
import { pool } from "../db/index.js";
import { computeBaseCase, getModelDefinition, getPLMetrics } from "../models/registry.js";
import { resolveBasePl } from "./basePl.js";
import { fmtIndianCurrency } from "../utils/formatNumber.js";

interface PeriodBreakdown {
  period: string;
  pl: Record<string, number>;
}

interface DenominationMeta {
  currency: string;
  currency_unit: string;
  company_name: string | null;
}

interface FidelityMeta {
  validation_status: string | null;
  score: number | null;
  key_output_score: number | null;
  ready: boolean | null;
  divergence_count: number;
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

function fmtNum(n: number, currency = "USD"): string {
  return fmtIndianCurrency(n, currency === "Rs" ? "INR" : currency, { maximumFractionDigits: 0 });
}

function addSectionTitle(
  slide: {
    addText: (text: string, options?: Record<string, unknown>) => unknown;
    addShape: (shapeType: unknown, options?: Record<string, unknown>) => unknown;
  },
  pptx: { ShapeType: { rect: unknown } },
  title: string,
) {
  slide.addText(title, {
    x: 0.5, y: 0.3, w: 10, h: 0.6,
    fontSize: 22, fontFace: "Arial",
    color: DELOITTE.black, bold: true,
  });
  slide.addShape(pptx.ShapeType.rect, {
    x: 0.5, y: 0.85, w: 2.5, h: 0.04,
    fill: { color: DELOITTE.green },
  });
}

async function loadExportEnrichment(scenarioId: string): Promise<{
  denom: DenominationMeta;
  fidelity: FidelityMeta;
  extraOutputs: Array<{ output_type: string; output_data: Record<string, unknown> }>;
}> {
  const ws = await pool.query(
    `SELECT workspace_id FROM scenarios WHERE scenario_id = $1`,
    [scenarioId],
  );
  const workspaceId = ws.rows[0]?.workspace_id as string | undefined;

  let denom: DenominationMeta = { currency: "USD", currency_unit: "Million", company_name: null };
  let fidelity: FidelityMeta = {
    validation_status: null,
    score: null,
    key_output_score: null,
    ready: null,
    divergence_count: 0,
  };

  if (workspaceId) {
    const ctx = await pool.query(
      `SELECT company_name, context_data FROM company_context
       WHERE workspace_id = $1 AND status = 'active'
       ORDER BY created_at DESC LIMIT 1`,
      [workspaceId],
    );
    const ctxData = (ctx.rows[0]?.context_data ?? {}) as Record<string, unknown>;
    denom = {
      currency: (ctxData.currency as string) || "USD",
      currency_unit: (ctxData.currency_unit as string) || (ctxData.canonical_unit as string) || "Million",
      company_name: (ctx.rows[0]?.company_name as string) || (ctxData.company_name as string) || null,
    };
    const rv = ctxData.runtime_validation as
      | { fidelity?: { score?: number; key_output_score?: number; ready?: boolean; divergences?: unknown[] } }
      | undefined;
    const f = rv?.fidelity;
    if (f) {
      fidelity.score = typeof f.score === "number" ? f.score : null;
      fidelity.key_output_score = typeof f.key_output_score === "number" ? f.key_output_score : null;
      fidelity.ready = typeof f.ready === "boolean" ? f.ready : null;
      fidelity.divergence_count = Array.isArray(f.divergences) ? f.divergences.length : 0;
    }
    if (typeof ctxData.validation_status === "string") {
      fidelity.validation_status = ctxData.validation_status;
    }

    const doc = await pool.query(
      `SELECT validation_status FROM documents
       WHERE workspace_id = $1 AND model_schema IS NOT NULL
       ORDER BY CASE WHEN validation_status = 'ready' THEN 0 ELSE 1 END, created_at DESC
       LIMIT 1`,
      [workspaceId],
    );
    if (doc.rows[0]?.validation_status) {
      fidelity.validation_status = doc.rows[0].validation_status;
    }
  }

  const extras = await pool.query(
    `SELECT DISTINCT ON (output_type) output_type, output_data
     FROM scenario_outputs
     WHERE scenario_id = $1
       AND output_type IN ('goal_seek', 'sensitivity', 'sensitivity_two_way', 'driver_tree', 'attribution')
     ORDER BY output_type, created_at DESC`,
    [scenarioId],
  );

  return {
    denom,
    fidelity,
    extraOutputs: extras.rows.map((r: { output_type: string; output_data: Record<string, unknown> }) => ({
      output_type: r.output_type,
      output_data: r.output_data || {},
    })),
  };
}

export async function exportToPptx(scenarioId: string): Promise<Buffer> {
  // Fetch data
  const sRes = await pool.query("SELECT scenario_id, name, nl_input FROM scenarios WHERE scenario_id = $1", [scenarioId]);
  if (sRes.rows.length === 0) throw new Error("Scenario not found");
  const scenario = sRes.rows[0];

  const oRes = await pool.query(
    "SELECT output_id, output_data, narrative_summary FROM scenario_outputs WHERE scenario_id = $1 AND output_type = 'pl' ORDER BY created_at DESC LIMIT 1",
    [scenarioId]
  );
  const rawOutput = oRes.rows[0]?.output_data ?? {};
  const pl = rawOutput.aggregate ?? rawOutput;
  const periods: PeriodBreakdown[] = rawOutput.periods ?? [];
  const narrative = oRes.rows[0]?.narrative_summary ?? null;

  const pRes = await pool.query(
    `SELECT sp.extracted_name, sp.mapped_variable_id, sp.scenario_value, sp.status,
            sp.owner_user_id, u.name AS owner_name, sp.source_citation, sp.rationale,
            sp.effective_from, sp.review_status, sp.confidence_score
     FROM scenario_parameters sp
     LEFT JOIN users u ON u.user_id = sp.owner_user_id
     WHERE sp.scenario_id = $1 ORDER BY sp.created_at`,
    [scenarioId]
  );
  const params = pRes.rows;
  const manifestRes = oRes.rows[0]?.output_id
    ? await pool.query(
        `SELECT manifest_id, row_hash, model_hash, scenario_version_id, created_at, engine, mc
         FROM run_manifests WHERE run_id = $1`,
        [oRes.rows[0].output_id],
      )
    : { rows: [] };
  const manifest = manifestRes.rows[0] as
    | {
        manifest_id: string;
        row_hash: string;
        model_hash: string;
        scenario_version_id: string;
        created_at: string;
        engine: Record<string, unknown>;
        mc: Record<string, unknown> | null;
      }
    | undefined;

  const sModelRef = await pool.query("SELECT model_version_hash FROM scenarios WHERE scenario_id = $1", [scenarioId]);
  const modelHash = sModelRef.rows[0]?.model_version_hash;
  const model = await getModelDefinition(modelHash);
  const baseValues = await resolveBasePl(rawOutput, model, scenarioId);
  const plMetrics = model
    ? getPLMetrics(model)
    : [...new Set([...Object.keys(pl), ...Object.keys(baseValues)])];
  if (model && Object.keys(baseValues).length === 0) {
    Object.assign(baseValues, await computeBaseCase(model));
  }
  const periodCount = periods.length || 1;
  const { denom, fidelity, extraOutputs } = await loadExportEnrichment(scenarioId);
  const unitLabel = `${denom.currency} ${denom.currency_unit}`.trim();

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
  titleSlide.addText(
    `Denomination: ${unitLabel}${denom.company_name ? `  ·  ${denom.company_name}` : ""}`,
    {
      x: 0.8, y: 4.6, w: 10, h: 0.4,
      fontSize: 12, fontFace: "Arial",
      color: DELOITTE.grayLight,
    },
  );
  titleSlide.addShape(pptx.ShapeType.rect, {
    x: 0, y: 6.8, w: 13.33, h: 0.15,
    fill: { color: DELOITTE.green },
  });

  // ── Denomination / currency metadata ──
  {
    const metaSlide = pptx.addSlide();
    addSectionTitle(metaSlide, pptx, "Currency & Denomination");
    const rows: PptxTableRow[] = [
      [
        { text: "Field", options: { bold: true, color: DELOITTE.white, fill: { color: DELOITTE.charcoal }, fontSize: 11, fontFace: "Arial" } },
        { text: "Value", options: { bold: true, color: DELOITTE.white, fill: { color: DELOITTE.charcoal }, fontSize: 11, fontFace: "Arial" } },
      ],
      [{ text: "Currency", options: { fontSize: 10, fontFace: "Arial" } }, { text: denom.currency, options: { fontSize: 10, fontFace: "Arial" } }],
      [{ text: "Unit / scale", options: { fontSize: 10, fontFace: "Arial" } }, { text: denom.currency_unit, options: { fontSize: 10, fontFace: "Arial" } }],
      [{ text: "Company", options: { fontSize: 10, fontFace: "Arial" } }, { text: denom.company_name || "—", options: { fontSize: 10, fontFace: "Arial" } }],
    ];
    metaSlide.addTable(rows, {
      x: 0.5, y: 1.2, w: 8,
      border: { pt: 0.5, color: DELOITTE.grayLight },
      colW: [3, 5],
      rowH: 0.4,
    });
    metaSlide.addText("All P&L figures in this deck use the denomination above unless noted.", {
      x: 0.5, y: 3.2, w: 10, h: 0.4,
      fontSize: 11, fontFace: "Arial", color: DELOITTE.gray, italic: true,
    });
  }

  // ── P&L Summary ──
  const plSlide = pptx.addSlide();
  addSectionTitle(plSlide, pptx, "P&L Impact Summary");
  plSlide.addText(`Figures in ${unitLabel}`, {
    x: 8, y: 0.4, w: 4.5, h: 0.35,
    fontSize: 10, fontFace: "Arial", color: DELOITTE.gray, align: "right",
  });

  const plRows: PptxTableRow[] = [];
  plRows.push([
    { text: "Metric", options: { bold: true, color: DELOITTE.white, fill: { color: DELOITTE.charcoal }, fontSize: 11, fontFace: "Arial" } },
    { text: "Base", options: { bold: true, color: DELOITTE.white, fill: { color: DELOITTE.charcoal }, fontSize: 11, fontFace: "Arial", align: "right" } },
    { text: "Scenario", options: { bold: true, color: DELOITTE.white, fill: { color: DELOITTE.charcoal }, fontSize: 11, fontFace: "Arial", align: "right" } },
    { text: "Delta", options: { bold: true, color: DELOITTE.white, fill: { color: DELOITTE.charcoal }, fontSize: 11, fontFace: "Arial", align: "right" } },
    { text: "Delta %", options: { bold: true, color: DELOITTE.white, fill: { color: DELOITTE.charcoal }, fontSize: 11, fontFace: "Arial", align: "right" } },
  ]);

  const chartCategories: string[] = [];
  const chartBase: number[] = [];
  const chartScen: number[] = [];

  for (const key of plMetrics) {
    const base = Math.round((baseValues[key] ?? 0) * periodCount * 100) / 100;
    const scenVal = pl[key] ?? 0;
    const delta = Math.round((scenVal - base) * 100) / 100;
    const deltaPct = base !== 0 ? Math.round((delta / base) * 10000) / 100 : 0;
    const deltaColor = delta >= 0 ? DELOITTE.green : DELOITTE.red;

    plRows.push([
      { text: metricLabel(key), options: { fontSize: 10, fontFace: "Arial", bold: true } },
      { text: fmtNum(base, denom.currency), options: { fontSize: 10, fontFace: "Arial", align: "right" } },
      { text: fmtNum(scenVal, denom.currency), options: { fontSize: 10, fontFace: "Arial", align: "right", bold: true } },
      { text: `${delta >= 0 ? "+" : "-"}${fmtNum(delta, denom.currency)}`, options: { fontSize: 10, fontFace: "Arial", align: "right", color: deltaColor, bold: true } },
      { text: `${deltaPct >= 0 ? "+" : ""}${deltaPct}%`, options: { fontSize: 10, fontFace: "Arial", align: "right", color: deltaColor } },
    ]);

    if (chartCategories.length < 8) {
      chartCategories.push(metricLabel(key));
      chartBase.push(base);
      chartScen.push(scenVal);
    }
  }

  plSlide.addTable(plRows, {
    x: 0.5, y: 1.2, w: 10,
    border: { pt: 0.5, color: DELOITTE.grayLight },
    colW: [2.5, 1.8, 1.8, 1.8, 1.3],
    rowH: 0.4,
  });

  // ── Native bar chart: Base vs Scenario ──
  if (chartCategories.length > 0) {
    const chartSlide = pptx.addSlide();
    addSectionTitle(chartSlide, pptx, "P&L Base vs Scenario");
    chartSlide.addText(`Figures in ${unitLabel}`, {
      x: 8, y: 0.4, w: 4.5, h: 0.35,
      fontSize: 10, fontFace: "Arial", color: DELOITTE.gray, align: "right",
    });
    chartSlide.addChart(pptx.ChartType.bar, [
      {
        name: "Base",
        labels: chartCategories,
        values: chartBase,
      },
      {
        name: "Scenario",
        labels: chartCategories,
        values: chartScen,
      },
    ], {
      x: 0.5,
      y: 1.2,
      w: 12,
      h: 5,
      barGrouping: "clustered",
      showTitle: false,
      showLegend: true,
      legendPos: "b",
      showValue: false,
      catAxisLabelColor: DELOITTE.charcoal,
      catAxisLabelFontSize: 9,
      valAxisLabelFontSize: 9,
      chartColors: [DELOITTE.gray, DELOITTE.green],
    });
  }

  // ── Period Breakdown (if multi-period) ──
  if (periods.length > 1) {
    const periodSlide = pptx.addSlide();
    addSectionTitle(periodSlide, pptx, "Period Breakdown");

    const pRows: PptxTableRow[] = [];
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
        cells.push({ text: fmtNum(val, denom.currency), options: { fontSize: 9, fontFace: "Arial", align: "center" } });
      }
      cells.push({ text: fmtNum(total, denom.currency), options: { fontSize: 9, fontFace: "Arial", align: "right", bold: true } });
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

  // ── Key Assumptions ──
  if (params.length > 0) {
    const paramSlide = pptx.addSlide();
    addSectionTitle(paramSlide, pptx, "Key Assumptions");

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

  // ── Sign-off Assumptions Book ──
  if (params.length > 0) {
    const assumptionsSlide = pptx.addSlide();
    addSectionTitle(assumptionsSlide, pptx, "Assumptions Book");
    const rows: PptxTableRow[] = [[
      { text: "Assumption", options: { bold: true, color: DELOITTE.white, fill: { color: DELOITTE.charcoal }, fontSize: 9 } },
      { text: "Value", options: { bold: true, color: DELOITTE.white, fill: { color: DELOITTE.charcoal }, fontSize: 9 } },
      { text: "Owner", options: { bold: true, color: DELOITTE.white, fill: { color: DELOITTE.charcoal }, fontSize: 9 } },
      { text: "Source / Rationale", options: { bold: true, color: DELOITTE.white, fill: { color: DELOITTE.charcoal }, fontSize: 9 } },
      { text: "Effective / Status", options: { bold: true, color: DELOITTE.white, fill: { color: DELOITTE.charcoal }, fontSize: 9 } },
    ]];
    for (const parameter of params.slice(0, 14)) {
      rows.push([
        { text: parameter.extracted_name, options: { fontSize: 8 } },
        { text: String(parameter.scenario_value), options: { fontSize: 8, align: "right" } },
        { text: parameter.owner_name || parameter.owner_user_id || "—", options: { fontSize: 8 } },
        {
          text: [parameter.source_citation, parameter.rationale].filter(Boolean).join(" · ") || "—",
          options: { fontSize: 8 },
        },
        {
          text: `${parameter.effective_from ? new Date(parameter.effective_from).toISOString().slice(0, 10) : "—"} · ${parameter.review_status || "draft"}`,
          options: { fontSize: 8 },
        },
      ]);
    }
    assumptionsSlide.addTable(rows, {
      x: 0.35, y: 1.05, w: 12.6,
      border: { pt: 0.4, color: DELOITTE.grayLight },
      colW: [2.6, 1.2, 2, 4.4, 2.4],
      rowH: 0.34,
    });
    assumptionsSlide.addText(`Manifest: ${manifest?.row_hash || "legacy run"}`, {
      x: 0.5, y: 6.9, w: 12, h: 0.25, fontSize: 7, color: DELOITTE.gray,
    });
  }

  // ── Fidelity status ──
  if (fidelity.validation_status || fidelity.score != null || fidelity.ready != null) {
    const fidSlide = pptx.addSlide();
    addSectionTitle(fidSlide, pptx, "Model Fidelity Status");
    const fidRows: PptxTableRow[] = [
      [
        { text: "Check", options: { bold: true, color: DELOITTE.white, fill: { color: DELOITTE.charcoal }, fontSize: 11, fontFace: "Arial" } },
        { text: "Result", options: { bold: true, color: DELOITTE.white, fill: { color: DELOITTE.charcoal }, fontSize: 11, fontFace: "Arial" } },
      ],
      [
        { text: "Validation status", options: { fontSize: 10, fontFace: "Arial" } },
        { text: fidelity.validation_status || "—", options: { fontSize: 10, fontFace: "Arial" } },
      ],
      [
        { text: "Fidelity ready", options: { fontSize: 10, fontFace: "Arial" } },
        {
          text: fidelity.ready == null ? "—" : fidelity.ready ? "Yes" : "No",
          options: { fontSize: 10, fontFace: "Arial", color: fidelity.ready ? DELOITTE.green : DELOITTE.red },
        },
      ],
      [
        { text: "Fidelity score", options: { fontSize: 10, fontFace: "Arial" } },
        {
          text: fidelity.score != null ? `${Math.round(fidelity.score * 1000) / 10}%` : "—",
          options: { fontSize: 10, fontFace: "Arial" },
        },
      ],
      [
        { text: "Key-output score", options: { fontSize: 10, fontFace: "Arial" } },
        {
          text: fidelity.key_output_score != null ? `${Math.round(fidelity.key_output_score * 1000) / 10}%` : "—",
          options: { fontSize: 10, fontFace: "Arial" },
        },
      ],
      [
        { text: "Divergences", options: { fontSize: 10, fontFace: "Arial" } },
        { text: String(fidelity.divergence_count), options: { fontSize: 10, fontFace: "Arial" } },
      ],
    ];
    fidSlide.addTable(fidRows, {
      x: 0.5, y: 1.2, w: 8,
      border: { pt: 0.5, color: DELOITTE.grayLight },
      colW: [3.5, 4.5],
      rowH: 0.4,
    });
  }

  // ── Analysis outputs (goal-seek / sensitivity / driver tree / attribution) ──
  for (const extra of extraOutputs) {
    const slide = pptx.addSlide();
    const titleMap: Record<string, string> = {
      goal_seek: "Goal Seek Results",
      sensitivity: "Sensitivity Analysis",
      sensitivity_two_way: "Two-Way Sensitivity",
      driver_tree: "Driver Tree",
      attribution: "Driver Attribution",
    };
    addSectionTitle(slide, pptx, titleMap[extra.output_type] || extra.output_type);

    const data = extra.output_data;
    const rows: PptxTableRow[] = [
      [
        { text: "Field", options: { bold: true, color: DELOITTE.white, fill: { color: DELOITTE.charcoal }, fontSize: 10, fontFace: "Arial" } },
        { text: "Value", options: { bold: true, color: DELOITTE.white, fill: { color: DELOITTE.charcoal }, fontSize: 10, fontFace: "Arial" } },
      ],
    ];

    if (extra.output_type === "goal_seek") {
      const fields = [
        ["Target metric", data.target_metric],
        ["Variable", data.variable_id],
        ["Target value", data.target_value],
        ["Solved value", data.solved_value],
        ["Converged", data.converged],
        ["Iterations", data.iterations],
      ];
      for (const [label, val] of fields) {
        if (val == null) continue;
        rows.push([
          { text: String(label), options: { fontSize: 10, fontFace: "Arial" } },
          { text: String(val), options: { fontSize: 10, fontFace: "Arial" } },
        ]);
      }
    } else if (extra.output_type === "sensitivity" || extra.output_type === "sensitivity_two_way") {
      rows.push([
        { text: "Target metric", options: { fontSize: 10, fontFace: "Arial" } },
        { text: String(data.target_metric ?? "—"), options: { fontSize: 10, fontFace: "Arial" } },
      ]);
      const bars = (data.bars || data.results || []) as Array<Record<string, unknown>>;
      if (Array.isArray(bars)) {
        for (const b of bars.slice(0, 12)) {
          const name = String(b.variable_name || b.variable_id || b.name || "item");
          const low = b.low_value ?? b.down ?? b.min;
          const high = b.high_value ?? b.up ?? b.max;
          rows.push([
            { text: name, options: { fontSize: 9, fontFace: "Arial" } },
            {
              text: low != null || high != null ? `${low ?? "—"} → ${high ?? "—"}` : JSON.stringify(b).slice(0, 80),
              options: { fontSize: 9, fontFace: "Arial" },
            },
          ]);
        }
      }
    } else if (extra.output_type === "attribution") {
      rows.push([
        { text: "Target metric", options: { fontSize: 10, fontFace: "Arial" } },
        { text: String(data.target_metric ?? "—"), options: { fontSize: 10, fontFace: "Arial" } },
      ]);
      rows.push([
        { text: "Total delta", options: { fontSize: 10, fontFace: "Arial" } },
        { text: String(data.total_delta ?? "—"), options: { fontSize: 10, fontFace: "Arial" } },
      ]);
      const bars = (data.bars || []) as Array<Record<string, unknown>>;
      for (const b of bars.slice(0, 12)) {
        rows.push([
          { text: String(b.variable_name || b.variable_id || "driver"), options: { fontSize: 9, fontFace: "Arial" } },
          { text: String(b.contribution ?? "—"), options: { fontSize: 9, fontFace: "Arial" } },
        ]);
      }
    } else {
      // driver_tree or unknown — dump top-level scalars
      for (const [k, v] of Object.entries(data).slice(0, 15)) {
        if (v == null || typeof v === "object") continue;
        rows.push([
          { text: metricLabel(k), options: { fontSize: 10, fontFace: "Arial" } },
          { text: String(v), options: { fontSize: 10, fontFace: "Arial" } },
        ]);
      }
      if (data.target_metric) {
        rows.splice(1, 0, [
          { text: "Target metric", options: { fontSize: 10, fontFace: "Arial" } },
          { text: String(data.target_metric), options: { fontSize: 10, fontFace: "Arial" } },
        ]);
      }
    }

    if (rows.length > 1) {
      slide.addTable(rows, {
        x: 0.5, y: 1.2, w: 10,
        border: { pt: 0.5, color: DELOITTE.grayLight },
        colW: [4, 6],
        rowH: 0.35,
      });
    } else {
      slide.addText("Output recorded but no tabular fields available.", {
        x: 0.5, y: 1.3, w: 10, h: 0.4,
        fontSize: 11, fontFace: "Arial", color: DELOITTE.gray,
      });
    }
  }

  // ── Executive Summary ──
  if (narrative) {
    const narSlide = pptx.addSlide();
    addSectionTitle(narSlide, pptx, "Executive Summary");
    narSlide.addText(narrative, {
      x: 0.5, y: 1.3, w: 11, h: 4.5,
      fontSize: 12, fontFace: "Arial",
      color: DELOITTE.charcoal,
      lineSpacing: 20,
      valign: "top",
    });
  }

  // ── Immutable Provenance ──
  {
    const provenanceSlide = pptx.addSlide();
    addSectionTitle(provenanceSlide, pptx, "Immutable Run Provenance");
    const rows: PptxTableRow[] = [
      ["Manifest ID", manifest?.manifest_id || "Legacy run — unavailable"],
      ["Manifest row hash", manifest?.row_hash || "—"],
      ["Model hash", manifest?.model_hash || "—"],
      ["Scenario version", manifest?.scenario_version_id || "—"],
      ["Run timestamp", manifest?.created_at ? new Date(manifest.created_at).toISOString() : "—"],
      ["Engine", manifest ? JSON.stringify(manifest.engine) : "—"],
      ["Monte Carlo disclosure", manifest?.mc ? JSON.stringify(manifest.mc) : "Not applicable"],
    ].map(([label, value]) => [
      { text: label, options: { bold: true, fontSize: 9 } },
      { text: value, options: { fontSize: 8 } },
    ]);
    provenanceSlide.addTable(rows, {
      x: 0.5, y: 1.2, w: 12,
      border: { pt: 0.5, color: DELOITTE.grayLight },
      colW: [2.6, 9.4],
      rowH: 0.48,
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
