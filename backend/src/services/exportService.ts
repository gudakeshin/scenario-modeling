import ExcelJS from "exceljs";
import { pool } from "../db/index.js";
import { computeBaseCase, getModelDefinition, getPLMetrics } from "../models/registry.js";

interface PeriodBreakdown {
  period: string;
  pl: Record<string, number>;
}

interface ExportData {
  scenario_id: string;
  name: string | null;
  nl_input: string;
  pl: Record<string, number>;
  periods: PeriodBreakdown[];
  granularity: string;
  parameters: { extracted_name: string; mapped_variable_id: string; scenario_value: number; status: string }[];
  narrative: string | null;
}

async function loadExportData(scenarioId: string): Promise<ExportData> {
  const sRes = await pool.query("SELECT scenario_id, name, nl_input FROM scenarios WHERE scenario_id = $1", [scenarioId]);
  if (sRes.rows.length === 0) throw new Error("Scenario not found");
  const row = sRes.rows[0];

  const oRes = await pool.query(
    "SELECT output_data, narrative_summary FROM scenario_outputs WHERE scenario_id = $1 AND output_type = 'pl' ORDER BY created_at DESC LIMIT 1",
    [scenarioId]
  );
  const rawOutput = oRes.rows[0]?.output_data ?? {};
  // Handle both multi-period format (has .aggregate) and legacy flat format
  const pl = rawOutput.aggregate ?? rawOutput;
  const periods: PeriodBreakdown[] = rawOutput.periods ?? [];
  const granularity: string = rawOutput.granularity ?? "quarterly";
  const narrative = oRes.rows[0]?.narrative_summary ?? null;

  const pRes = await pool.query(
    "SELECT extracted_name, mapped_variable_id, scenario_value, status FROM scenario_parameters WHERE scenario_id = $1 ORDER BY created_at",
    [scenarioId]
  );

  return { scenario_id: scenarioId, name: row.name, nl_input: row.nl_input, pl, periods, granularity, parameters: pRes.rows, narrative };
}

// Dynamic metric label generation from model
function metricLabel(id: string): string {
  return id.split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

export async function exportToExcel(scenarioId: string): Promise<Buffer> {
  const data = await loadExportData(scenarioId);
  const wb = new ExcelJS.Workbook();
  wb.creator = "Scenario Modeling | Deloitte";
  wb.created = new Date();

  const sRef = await pool.query("SELECT model_version_hash FROM scenarios WHERE scenario_id = $1", [scenarioId]);
  const modelHash = sRef.rows[0]?.model_version_hash;
  const model = await getModelDefinition(modelHash);
  if (!model) throw new Error("No model found for this scenario");
  const baseValues = await computeBaseCase(model);
  const plMetrics = getPLMetrics(model);

  // Deloitte-style header formatting
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
  ];
  const basePeriodCount = data.periods.length || 1;
  for (const key of plMetrics) {
    const basePer = Math.round((baseValues[key] ?? 0) * 100) / 100;
    const baseTotal = Math.round(basePer * basePeriodCount * 100) / 100;
    const scenario = data.pl[key] ?? 0;
    const delta = Math.round((scenario - baseTotal) * 100) / 100;
    const deltaPct = baseTotal !== 0 ? Math.round((delta / baseTotal) * 10000) / 100 : 0;
    plSheet.addRow({ metric: metricLabel(key), base: baseTotal, scenario, delta, delta_pct: deltaPct });
  }
  const plHeaderRow = plSheet.getRow(1);
  plHeaderRow.font = headerFont;
  plHeaderRow.fill = headerFill;

  // ── Period Breakdown Sheet ──
  if (data.periods.length > 1) {
    const periodSheet = wb.addWorksheet("Period Breakdown");
    // Columns: Metric | Period1 | Period2 | ... | Total
    const cols: Partial<ExcelJS.Column>[] = [{ header: "Metric", key: "metric", width: 20 }];
    for (const p of data.periods) {
      cols.push({ header: p.period, key: p.period, width: 14 });
    }
    cols.push({ header: "Total", key: "total", width: 15 });
    periodSheet.columns = cols;

    for (const key of plMetrics) {
      const rowData: Record<string, string | number> = { metric: metricLabel(key) };
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

    // Highlight total column
    const totalColIdx = data.periods.length + 2; // 1-indexed, after metric + periods
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
  const sRef = await pool.query("SELECT model_version_hash FROM scenarios WHERE scenario_id = $1", [scenarioId]);
  const modelHash = sRef.rows[0]?.model_version_hash;
  const model = await getModelDefinition(modelHash);
  if (!model) throw new Error("No model found for this scenario");
  const baseValues = await computeBaseCase(model);
  const plMetrics = getPLMetrics(model);

  const sections: string[] = [];

  // Aggregate summary
  const basePeriodCount = data.periods.length || 1;
  sections.push("=== P&L Summary (Total) ===");
  sections.push("Metric,Base Total,Scenario Total,Delta,Delta %");
  for (const key of plMetrics) {
    const basePer = Math.round((baseValues[key] ?? 0) * 100) / 100;
    const baseTotal = Math.round(basePer * basePeriodCount * 100) / 100;
    const scenario = data.pl[key] ?? 0;
    const delta = Math.round((scenario - baseTotal) * 100) / 100;
    const deltaPct = baseTotal !== 0 ? Math.round((delta / baseTotal) * 10000) / 100 : 0;
    sections.push(`"${metricLabel(key)}",${baseTotal},${scenario},${delta},${deltaPct}`);
  }

  // Period breakdown
  if (data.periods.length > 1) {
    sections.push("");
    sections.push(`=== Period Breakdown (${data.granularity}) ===`);
    const header = ["Metric", ...data.periods.map((p) => p.period), "Total"].join(",");
    sections.push(header);
    for (const key of plMetrics) {
      let total = 0;
      const vals = data.periods.map((p) => {
        const v = p.pl[key] ?? 0;
        total += v;
        return v;
      });
      sections.push(`"${metricLabel(key)}",${vals.join(",")},${Math.round(total * 100) / 100}`);
    }
  }

  return sections.join("\n");
}
