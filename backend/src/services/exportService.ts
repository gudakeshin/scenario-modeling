import ExcelJS from "exceljs";
import { pool } from "../db/index.js";
import { computeBaseCase, getModelDefinition, getPLMetrics } from "../models/registry.js";
import { resolveBasePl } from "./basePl.js";

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
  source_document_ids: string[];
}

interface ExportData {
  scenario_id: string;
  name: string | null;
  nl_input: string;
  pl: Record<string, number>;
  periods: PeriodBreakdown[];
  granularity: string;
  parameters: {
    extracted_name: string;
    mapped_variable_id: string;
    scenario_value: number;
    status: string;
    owner_user_id: string | null;
    owner_name: string | null;
    source_citation: string | null;
    rationale: string | null;
    effective_from: string | null;
    review_status: string;
    confidence_score: number | null;
  }[];
  narrative: string | null;
  raw_output: Record<string, unknown>;
  denom: DenominationMeta;
  fidelity: FidelityMeta;
  manifest: {
    manifest_id: string;
    row_hash: string;
    model_hash: string;
    scenario_version_id: string;
    created_at: string;
    engine: Record<string, unknown>;
    mc: Record<string, unknown> | null;
  } | null;
}

async function loadDenominationAndFidelity(scenarioId: string): Promise<{
  denom: DenominationMeta;
  fidelity: FidelityMeta;
}> {
  const ws = await pool.query(`SELECT workspace_id FROM scenarios WHERE scenario_id = $1`, [scenarioId]);
  const workspaceId = ws.rows[0]?.workspace_id as string | undefined;
  let denom: DenominationMeta = { currency: "USD", currency_unit: "Million", company_name: null };
  let fidelity: FidelityMeta = {
    validation_status: null,
    score: null,
    key_output_score: null,
    ready: null,
    divergence_count: 0,
    source_document_ids: [],
  };
  if (!workspaceId) return { denom, fidelity };

  const ctx = await pool.query(
    `SELECT company_name, context_data, source_document_ids FROM company_context
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
  if (typeof ctxData.validation_status === "string") fidelity.validation_status = ctxData.validation_status;
  if (Array.isArray(ctx.rows[0]?.source_document_ids)) {
    fidelity.source_document_ids = ctx.rows[0].source_document_ids as string[];
  }

  const doc = await pool.query(
    `SELECT document_id, validation_status, original_filename
     FROM documents
     WHERE workspace_id = $1 AND model_schema IS NOT NULL
     ORDER BY CASE WHEN validation_status = 'ready' THEN 0 ELSE 1 END, created_at DESC
     LIMIT 5`,
    [workspaceId],
  );
  if (doc.rows[0]?.validation_status) fidelity.validation_status = doc.rows[0].validation_status;
  for (const row of doc.rows) {
    if (row.document_id && !fidelity.source_document_ids.includes(row.document_id)) {
      fidelity.source_document_ids.push(row.document_id);
    }
  }

  return { denom, fidelity };
}

async function loadExportData(scenarioId: string): Promise<ExportData> {
  const sRes = await pool.query("SELECT scenario_id, name, nl_input FROM scenarios WHERE scenario_id = $1", [scenarioId]);
  if (sRes.rows.length === 0) throw new Error("Scenario not found");
  const row = sRes.rows[0];

  const oRes = await pool.query(
    "SELECT output_id, output_data, narrative_summary FROM scenario_outputs WHERE scenario_id = $1 AND output_type = 'pl' ORDER BY created_at DESC LIMIT 1",
    [scenarioId]
  );
  const rawOutput = oRes.rows[0]?.output_data ?? {};
  const pl = rawOutput.aggregate ?? rawOutput;
  const periods: PeriodBreakdown[] = rawOutput.periods ?? [];
  const granularity: string = rawOutput.granularity ?? "quarterly";
  const narrative = oRes.rows[0]?.narrative_summary ?? null;

  const pRes = await pool.query(
    `SELECT sp.extracted_name, sp.mapped_variable_id, sp.scenario_value, sp.status,
            sp.owner_user_id, u.name AS owner_name, sp.source_citation, sp.rationale,
            sp.effective_from, sp.review_status, sp.confidence_score
     FROM scenario_parameters sp
     LEFT JOIN users u ON u.user_id = sp.owner_user_id
     WHERE sp.scenario_id = $1
     ORDER BY sp.created_at`,
    [scenarioId]
  );
  const manifestRes = oRes.rows[0]?.output_id
    ? await pool.query(
        `SELECT manifest_id, row_hash, model_hash, scenario_version_id, created_at, engine, mc
         FROM run_manifests WHERE run_id = $1`,
        [oRes.rows[0].output_id],
      )
    : { rows: [] };

  const { denom, fidelity } = await loadDenominationAndFidelity(scenarioId);

  return {
    scenario_id: scenarioId,
    name: row.name,
    nl_input: row.nl_input,
    pl,
    periods,
    granularity,
    parameters: pRes.rows,
    narrative,
    raw_output: rawOutput,
    denom,
    fidelity,
    manifest: manifestRes.rows[0] ?? null,
  };
}

function metricLabel(id: string): string {
  return id.split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

async function resolveExportBase(
  scenarioId: string,
  rawOutput: Record<string, unknown>,
): Promise<{ baseValues: Record<string, number>; plMetrics: string[] }> {
  const sRef = await pool.query("SELECT model_version_hash FROM scenarios WHERE scenario_id = $1", [scenarioId]);
  const modelHash = sRef.rows[0]?.model_version_hash;
  const model = await getModelDefinition(modelHash);
  let baseValues = await resolveBasePl(rawOutput, model, scenarioId);
  if (model) {
    if (Object.keys(baseValues).length === 0) baseValues = await computeBaseCase(model);
    return { baseValues, plMetrics: getPLMetrics(model) };
  }
  const keys = new Set<string>(Object.keys(baseValues));
  if (rawOutput.aggregate && typeof rawOutput.aggregate === "object") {
    for (const k of Object.keys(rawOutput.aggregate as object)) keys.add(k);
  }
  return { baseValues, plMetrics: [...keys] };
}

export async function exportToExcel(scenarioId: string): Promise<Buffer> {
  const data = await loadExportData(scenarioId);
  const wb = new ExcelJS.Workbook();
  wb.creator = "Scenario Modeling | Deloitte";
  wb.created = new Date();

  const { baseValues, plMetrics } = await resolveExportBase(scenarioId, data.raw_output);

  const headerFill: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1D1D1B" } };
  const headerFont: Partial<ExcelJS.Font> = { bold: true, color: { argb: "FFFFFFFF" } };
  const accentFill: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF86BC25" } };

  // ── P&L Summary Sheet (Aggregate) ──
  const plSheet = wb.addWorksheet("P&L Summary");
  plSheet.columns = [
    { header: "Metric", key: "metric", width: 20 },
    { header: "Base (per period)", key: "base", width: 18 },
    { header: "Scenario (Total)", key: "scenario", width: 18 },
    { header: "Delta", key: "delta", width: 15 },
    { header: "Delta %", key: "delta_pct", width: 12 },
    { header: "Currency", key: "currency", width: 12 },
    { header: "Unit", key: "unit", width: 12 },
  ];
  const basePeriodCount = data.periods.length || 1;
  for (const key of plMetrics) {
    const basePer = Math.round((baseValues[key] ?? 0) * 100) / 100;
    const baseTotal = Math.round(basePer * basePeriodCount * 100) / 100;
    const scenario = data.pl[key] ?? 0;
    const delta = Math.round((scenario - baseTotal) * 100) / 100;
    const deltaPct = baseTotal !== 0 ? Math.round((delta / baseTotal) * 10000) / 100 : 0;
    plSheet.addRow({
      metric: metricLabel(key),
      base: baseTotal,
      scenario,
      delta,
      delta_pct: deltaPct,
      currency: data.denom.currency,
      unit: data.denom.currency_unit,
    });
  }
  const plHeaderRow = plSheet.getRow(1);
  plHeaderRow.font = headerFont;
  plHeaderRow.fill = headerFill;

  // ── Period Breakdown Sheet ──
  if (data.periods.length > 1) {
    const periodSheet = wb.addWorksheet("Period Breakdown");
    const cols: Partial<ExcelJS.Column>[] = [{ header: "Metric", key: "metric", width: 20 }];
    for (const p of data.periods) {
      cols.push({ header: p.period, key: p.period, width: 14 });
    }
    cols.push({ header: "Total", key: "total", width: 15 });
    cols.push({ header: "Currency", key: "currency", width: 12 });
    cols.push({ header: "Unit", key: "unit", width: 12 });
    periodSheet.columns = cols;

    for (const key of plMetrics) {
      const rowData: Record<string, string | number> = {
        metric: metricLabel(key),
        currency: data.denom.currency,
        unit: data.denom.currency_unit,
      };
      let total = 0;
      for (const p of data.periods) {
        const val = p.pl[key] ?? 0;
        rowData[p.period] = val;
        total += val;
      }
      rowData.total = Math.round(total * 100) / 100;
      periodSheet.addRow(rowData);
    }

    const pHeaderRow = periodSheet.getRow(1);
    pHeaderRow.font = headerFont;
    pHeaderRow.fill = headerFill;

    const totalColIdx = data.periods.length + 2;
    for (let r = 2; r <= plMetrics.length + 1; r++) {
      const cell = periodSheet.getCell(r, totalColIdx);
      cell.font = { bold: true };
    }
  }

  // ── Parameters Sheet ──
  const paramSheet = wb.addWorksheet("Parameters");
  paramSheet.columns = [
    { header: "Parameter", key: "name", width: 30 },
    { header: "Model Variable", key: "variable", width: 25 },
    { header: "Value", key: "value", width: 12 },
    { header: "Status", key: "status", width: 12 },
  ];
  for (const p of data.parameters) {
    paramSheet.addRow({ name: p.extracted_name, variable: p.mapped_variable_id, value: p.scenario_value, status: p.status });
  }
  const paramHeaderRow = paramSheet.getRow(1);
  paramHeaderRow.font = headerFont;
  paramHeaderRow.fill = headerFill;

  // ── Assumptions Book Sheet ──
  const assumptionsSheet = wb.addWorksheet("Assumptions Book");
  assumptionsSheet.columns = [
    { header: "Assumption", key: "name", width: 28 },
    { header: "Model Variable", key: "variable", width: 24 },
    { header: "Value (raw precision)", key: "value", width: 20 },
    { header: "Owner", key: "owner", width: 22 },
    { header: "Source / Citation", key: "source", width: 35 },
    { header: "Rationale", key: "rationale", width: 45 },
    { header: "Effective Date", key: "effective", width: 16 },
    { header: "Review Status", key: "review", width: 16 },
    { header: "Confidence", key: "confidence", width: 14 },
  ];
  for (const parameter of data.parameters) {
    assumptionsSheet.addRow({
      name: parameter.extracted_name,
      variable: parameter.mapped_variable_id,
      value: Number(parameter.scenario_value),
      owner: parameter.owner_name || parameter.owner_user_id || "",
      source: parameter.source_citation || "",
      rationale: parameter.rationale || "",
      effective: parameter.effective_from
        ? new Date(parameter.effective_from).toISOString().slice(0, 10)
        : "",
      review: parameter.review_status,
      confidence:
        parameter.confidence_score == null ? "" : Number(parameter.confidence_score),
    });
  }
  assumptionsSheet.getRow(1).font = headerFont;
  assumptionsSheet.getRow(1).fill = headerFill;
  assumptionsSheet.addRow([]);
  assumptionsSheet.addRow([
    "Manifest hash",
    data.manifest?.row_hash || "Manifest unavailable (legacy run)",
  ]);

  // ── Sources / Fidelity Sheet ──
  const hasFidelity =
    data.fidelity.validation_status != null ||
    data.fidelity.score != null ||
    data.fidelity.ready != null ||
    data.fidelity.source_document_ids.length > 0;
  if (hasFidelity) {
    const fidSheet = wb.addWorksheet("Sources Fidelity");
    fidSheet.getColumn("A").width = 28;
    fidSheet.getColumn("B").width = 50;
    const fidTitle = fidSheet.addRow(["Sources & Fidelity"]);
    fidTitle.font = { bold: true, size: 14 };
    fidTitle.fill = accentFill;
    fidSheet.addRow([]);
    fidSheet.addRow(["Currency", data.denom.currency]);
    fidSheet.addRow(["Unit", data.denom.currency_unit]);
    fidSheet.addRow(["Company", data.denom.company_name || ""]);
    fidSheet.addRow(["Validation status", data.fidelity.validation_status || ""]);
    fidSheet.addRow(["Fidelity ready", data.fidelity.ready == null ? "" : data.fidelity.ready ? "Yes" : "No"]);
    fidSheet.addRow([
      "Fidelity score",
      data.fidelity.score != null ? Math.round(data.fidelity.score * 10000) / 100 : "",
    ]);
    fidSheet.addRow([
      "Key-output score",
      data.fidelity.key_output_score != null
        ? Math.round(data.fidelity.key_output_score * 10000) / 100
        : "",
    ]);
    fidSheet.addRow(["Divergence count", data.fidelity.divergence_count]);
    fidSheet.addRow([]);
    fidSheet.addRow(["Source document IDs"]);
    for (const id of data.fidelity.source_document_ids) {
      fidSheet.addRow([id]);
    }
  }

  // ── Immutable Provenance Sheet ──
  const provenanceSheet = wb.addWorksheet("Provenance");
  provenanceSheet.getColumn("A").width = 28;
  provenanceSheet.getColumn("B").width = 75;
  const provenanceTitle = provenanceSheet.addRow(["Immutable Run Provenance"]);
  provenanceTitle.font = { bold: true, size: 14 };
  provenanceTitle.fill = accentFill;
  provenanceSheet.addRow([]);
  provenanceSheet.addRow(["Manifest ID", data.manifest?.manifest_id || ""]);
  provenanceSheet.addRow(["Manifest row hash", data.manifest?.row_hash || "Legacy run — unavailable"]);
  provenanceSheet.addRow(["Model hash", data.manifest?.model_hash || ""]);
  provenanceSheet.addRow(["Scenario version", data.manifest?.scenario_version_id || ""]);
  provenanceSheet.addRow(["Run timestamp", data.manifest?.created_at || ""]);
  provenanceSheet.addRow(["Engine", data.manifest ? JSON.stringify(data.manifest.engine) : ""]);
  provenanceSheet.addRow([
    "Monte Carlo disclosure",
    data.manifest?.mc ? JSON.stringify(data.manifest.mc) : "Not applicable to deterministic run",
  ]);

  // ── Summary Sheet ──
  const summarySheet = wb.addWorksheet("Summary");
  summarySheet.getColumn("A").width = 20;
  summarySheet.getColumn("B").width = 80;

  const titleRow = summarySheet.addRow(["Scenario Modeling Report"]);
  titleRow.font = { bold: true, size: 14 };
  titleRow.fill = accentFill;

  summarySheet.addRow([]);
  summarySheet.addRow(["Scenario", data.name || data.scenario_id]);
  summarySheet.addRow(["Description", data.nl_input]);
  summarySheet.addRow(["Periods", `${data.periods.length} ${data.granularity}`]);
  summarySheet.addRow(["Currency", data.denom.currency]);
  summarySheet.addRow(["Denomination unit", data.denom.currency_unit]);
  summarySheet.addRow([]);
  if (data.narrative) {
    const narTitleRow = summarySheet.addRow(["Executive Summary"]);
    narTitleRow.font = { bold: true };
    summarySheet.addRow([data.narrative]);
  }

  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

export async function exportToCsv(scenarioId: string): Promise<string> {
  const data = await loadExportData(scenarioId);
  const { baseValues, plMetrics } = await resolveExportBase(scenarioId, data.raw_output);

  const sections: string[] = [];

  sections.push("=== Raw numeric precision; formatting is applied only in presentation exports ===");
  sections.push(`=== Denomination: ${data.denom.currency} ${data.denom.currency_unit} ===`);
  sections.push("=== P&L Summary (Total) ===");
  sections.push("Metric,Base Total,Scenario Total,Delta,Delta %,Currency,Unit");
  const basePeriodCount = data.periods.length || 1;
  for (const key of plMetrics) {
    const basePer = Math.round((baseValues[key] ?? 0) * 100) / 100;
    const baseTotal = Math.round(basePer * basePeriodCount * 100) / 100;
    const scenario = data.pl[key] ?? 0;
    const delta = Math.round((scenario - baseTotal) * 100) / 100;
    const deltaPct = baseTotal !== 0 ? Math.round((delta / baseTotal) * 10000) / 100 : 0;
    sections.push(
      `"${metricLabel(key)}",${baseTotal},${scenario},${delta},${deltaPct},${data.denom.currency},${data.denom.currency_unit}`,
    );
  }

  if (data.periods.length > 1) {
    sections.push("");
    sections.push(`=== Period Breakdown (${data.granularity}) ===`);
    const header = ["Metric", ...data.periods.map((p) => p.period), "Total", "Currency", "Unit"].join(",");
    sections.push(header);
    for (const key of plMetrics) {
      let total = 0;
      const vals = data.periods.map((p) => {
        const v = p.pl[key] ?? 0;
        total += v;
        return v;
      });
      sections.push(
        `"${metricLabel(key)}",${vals.join(",")},${Math.round(total * 100) / 100},${data.denom.currency},${data.denom.currency_unit}`,
      );
    }
  }

  sections.push("");
  sections.push("=== Assumptions Book ===");
  sections.push("Assumption,Model Variable,Value,Owner,Source,Rationale,Effective Date,Review Status,Confidence");
  const csv = (value: unknown) => `"${String(value ?? "").replace(/"/g, '""')}"`;
  for (const parameter of data.parameters) {
    sections.push([
      csv(parameter.extracted_name),
      csv(parameter.mapped_variable_id),
      Number(parameter.scenario_value),
      csv(parameter.owner_name || parameter.owner_user_id),
      csv(parameter.source_citation),
      csv(parameter.rationale),
      csv(parameter.effective_from ? new Date(parameter.effective_from).toISOString().slice(0, 10) : ""),
      csv(parameter.review_status),
      parameter.confidence_score ?? "",
    ].join(","));
  }
  sections.push("");
  sections.push("=== Provenance ===");
  sections.push(`Manifest Hash,${csv(data.manifest?.row_hash || "legacy run")}`);
  sections.push(`Model Hash,${csv(data.manifest?.model_hash || "")}`);
  sections.push(`Scenario Version,${csv(data.manifest?.scenario_version_id || "")}`);
  sections.push(`Run Timestamp,${csv(data.manifest?.created_at || "")}`);

  return sections.join("\n");
}
