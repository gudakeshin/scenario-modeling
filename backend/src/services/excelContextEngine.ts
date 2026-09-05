import { z } from "zod";
import { pool, resolveUserId } from "../db/index.js";
import { callClaudeStructured, getApiKey } from "./llmClient.js";
import type { ModelDefinition } from "../models/registry.js";
import type { WorkbookGraph } from "./excelExtractor.js";
import type { CompanyContext } from "./contextEngine.js";
import type { Scope } from "../middleware/workspace.js";
import { getDocumentChunksFromDb } from "./documentService.js";
import { logger } from "../logger.js";

const modelSchemaZ = z.object({
  company: z.string().default(""),
  industry: z.string().default(""),
  currency: z.string().default(""),
  unit: z.string().default(""),
  fiscalYear: z.string().default(""),
  scenarioLevers: z.array(z.object({
    id: z.string(),
    label: z.string(),
    type: z.string().default("input_driver"),
    category: z.string().default("assumption"),
    scenarios: z.object({
      base: z.number().optional(),
      bull: z.number().optional(),
      bear: z.number().optional(),
    }).default({}),
    affectsSheets: z.array(z.string()).default([]),
    unit: z.string().default("value"),
    sheet: z.string().optional(),
    cell: z.string().optional(),
    activeCell: z.string().optional(),
    aliasId: z.string().optional(),
    blockLabel: z.string().optional(),
  })).default([]),
  outputMetrics: z.array(z.object({
    id: z.string(),
    label: z.string(),
    sheet: z.string().default(""),
    row: z.number().default(0),
    cell: z.string().optional(),
    aggregateCell: z.string().optional(),
    aliasId: z.string().optional(),
    isKPI: z.boolean().default(false),
  })).default([]),
  timeDimension: z.object({
    granularity: z.enum(["monthly", "quarterly"]).default("quarterly"),
    periods: z.number().default(4),
    columns: z.array(z.string()).default([]),
  }).default({}),
  baseValues: z.record(z.number()).default({}),
});

interface ModelSchemaLever {
  id: string;
  label: string;
  type: string;
  category: string;
  scenarios?: { base?: number; bull?: number; bear?: number };
  affectsSheets: string[];
  unit: string;
  sheet?: string;
  cell?: string;
  /** "Active" column twin driven by a scenario toggle — the cell to write. */
  activeCell?: string;
  /** Bare label id, retained so schemas stored before block qualification resolve. */
  aliasId?: string;
  /** Section header that disambiguates repeated row labels. */
  blockLabel?: string;
}

interface ModelSchemaOutput {
  id: string;
  label: string;
  sheet: string;
  row: number;
  cell?: string;
  /** Workbook's own period-total cell for this row (e.g. P&L!O4). */
  aggregateCell?: string;
  aliasId?: string;
  isKPI: boolean;
}

export interface ModelSchema {
  company: string;
  industry: string;
  currency: string;
  unit: string;
  fiscalYear: string;
  scenarioLevers: ModelSchemaLever[];
  outputMetrics: ModelSchemaOutput[];
  timeDimension: { granularity: "monthly" | "quarterly"; periods: number; columns: string[] };
  baseValues: Record<string, number>;
}

interface ExtractionQualityReport {
  iteration: number;
  leverCoverage: { nonZero: number; total: number; pct: number };
  metricCoverage: { nonZero: number; total: number; pct: number };
  candidateAlignment: { leverMatches: number; leverTotal: number; metricMatches: number; metricTotal: number };
  passes: boolean;
  issues: string[];
}

function toId(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function safeNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeModelSchema(schema: ModelSchema, docName: string, graph: WorkbookGraph): ModelSchema {
  const inputCandidates = new Map(
    (graph.inputCandidates || []).map((c) => [toId(c.id || c.label || "input"), c]),
  );
  const outputCandidates = new Map(
    (graph.outputCandidates || []).map((c) => [toId(c.id || c.label || "metric"), c]),
  );

  const parsedLevers: ModelSchemaLever[] = (schema.scenarioLevers || [])
    .filter((l): l is ModelSchemaLever => !!l && typeof l === "object")
    .map((l) => {
      const id = toId(l.id || l.label || "lever");
      const cand = inputCandidates.get(id);
      const parsedBase = safeNumber(l.scenarios?.base, 0);
      return {
        id,
        label: l.label || l.id || "Lever",
        type: l.type || "input_driver",
        category: l.category || "driver",
        scenarios: {
          base: Math.abs(parsedBase) > 0 ? parsedBase : safeNumber(cand?.value, parsedBase),
          bull: safeNumber(l.scenarios?.bull, safeNumber(l.scenarios?.base, 0)),
          bear: safeNumber(l.scenarios?.bear, safeNumber(l.scenarios?.base, 0)),
        },
        affectsSheets: Array.isArray(l.affectsSheets) ? l.affectsSheets : (cand ? [cand.sheet] : []),
        unit: l.unit || "value",
        sheet: l.sheet || cand?.sheet,
        cell: l.cell || cand?.cell,
        ...(l.activeCell || cand?.activeCell
          ? { activeCell: l.activeCell || cand?.activeCell }
          : {}),
        ...(l.aliasId || cand?.aliasId ? { aliasId: l.aliasId || cand?.aliasId } : {}),
        ...(l.blockLabel || cand?.blockLabel
          ? { blockLabel: l.blockLabel || cand?.blockLabel }
          : {}),
      };
    });
  const fallbackLevers: ModelSchemaLever[] = (graph.inputCandidates || []).slice(0, 25).map((c) => ({
    id: toId(c.id || c.label || "input"),
    label: c.label || c.id,
    type: "input_driver",
    category: "assumption",
    scenarios: {
      base: safeNumber(c.value, 0),
      bull: safeNumber(c.value, 0) * 1.1,
      bear: safeNumber(c.value, 0) * 0.9,
    },
    affectsSheets: [c.sheet],
    unit: "value",
    sheet: c.sheet,
    cell: c.cell,
    ...(c.activeCell ? { activeCell: c.activeCell } : {}),
    ...(c.aliasId ? { aliasId: c.aliasId } : {}),
    ...(c.blockLabel ? { blockLabel: c.blockLabel } : {}),
  }));
  const normalizedLevers = parsedLevers.length > 0 ? parsedLevers : fallbackLevers;

  const parsedOutputs: ModelSchemaOutput[] = (schema.outputMetrics || [])
    .filter((m): m is ModelSchemaOutput => !!m && typeof m === "object")
    .map((m, idx) => {
      const id = toId(m.id || m.label || `metric_${idx + 1}`);
      const cand = outputCandidates.get(id);
      return {
        id,
        label: m.label || m.id || `Metric ${idx + 1}`,
        sheet: m.sheet || cand?.sheet || Object.keys(graph.sheets)[0] || "Sheet1",
        row: Number(m.row || cand?.row || idx + 1),
        cell: m.cell || cand?.cell,
        ...(m.aggregateCell || cand?.aggregateCell
          ? { aggregateCell: m.aggregateCell || cand?.aggregateCell }
          : {}),
        ...(m.aliasId || cand?.aliasId ? { aliasId: m.aliasId || cand?.aliasId } : {}),
        isKPI: Boolean(m.isKPI),
      };
    });
  const fallbackOutputs: ModelSchemaOutput[] = (graph.outputCandidates || []).slice(0, 20).map((c) => ({
    id: toId(c.id || c.label || "metric"),
    label: c.label || c.id,
    sheet: c.sheet,
    row: c.row,
    cell: c.cell,
    ...(c.aggregateCell ? { aggregateCell: c.aggregateCell } : {}),
    ...(c.aliasId ? { aliasId: c.aliasId } : {}),
    isKPI: true,
  }));
  const normalizedOutputs = parsedOutputs.length > 0 ? parsedOutputs : fallbackOutputs;
  const fallbackBaseValues: Record<string, number> = {};
  for (const c of graph.outputCandidates || []) {
    fallbackBaseValues[toId(c.id || c.label || "metric")] = safeNumber(c.value, 0);
  }
  // Metrics that only exist as input candidates (revenue_cr, sales_volume_mt, …)
  // must still seed baseValues so the catalog path has no zeros.
  for (const c of graph.inputCandidates || []) {
    const id = toId(c.id || c.label || "input");
    const v = safeNumber(c.value, 0);
    if (Math.abs(fallbackBaseValues[id] ?? 0) === 0 && Math.abs(v) > 0) {
      fallbackBaseValues[id] = v;
    }
  }
  const parsedBaseValues = schema.baseValues || {};
  const normalizedBaseValues: Record<string, number> = { ...fallbackBaseValues };
  for (const [k, v] of Object.entries(parsedBaseValues)) {
    const parsed = safeNumber(v, 0);
    if (Math.abs(parsed) > 0) {
      normalizedBaseValues[k] = parsed;
    } else if (outputCandidates.has(k)) {
      normalizedBaseValues[k] = safeNumber(outputCandidates.get(k)?.value, 0);
    } else if (inputCandidates.has(k)) {
      normalizedBaseValues[k] = safeNumber(inputCandidates.get(k)?.value, 0);
    } else {
      normalizedBaseValues[k] = parsed;
    }
  }

  return {
    company: schema.company || docName,
    industry: schema.industry || "Unknown",
    currency: schema.currency || graph.currency || "USD",
    unit: schema.unit || graph.unit || "Million",
    fiscalYear: schema.fiscalYear || "FY-Current",
    scenarioLevers: normalizedLevers,
    outputMetrics: normalizedOutputs,
    timeDimension: {
      granularity: schema.timeDimension?.granularity === "monthly" ? "monthly" : "quarterly",
      periods: Number(schema.timeDimension?.periods || graph.timeAxis?.columns?.length || 4),
      columns: Array.isArray(schema.timeDimension?.columns)
        ? schema.timeDimension.columns
        : (graph.timeAxis?.columns || []),
    },
    baseValues: normalizedBaseValues,
  };
}

function enrichFromCandidates(schema: ModelSchema, graph: WorkbookGraph): ModelSchema {
  const leverById = new Map(schema.scenarioLevers.map((l) => [toId(l.id), l]));
  const outputById = new Map(schema.outputMetrics.map((m) => [toId(m.id), m]));

  for (const c of graph.inputCandidates || []) {
    const cid = toId(c.id || c.label || "input");
    const cVal = safeNumber(c.value, 0);
    const existing = leverById.get(cid);
    if (existing) {
      const base = safeNumber(existing.scenarios?.base, 0);
      if (Math.abs(base) === 0 && Math.abs(cVal) > 0) {
        existing.scenarios = {
          base: cVal,
          bull: safeNumber(existing.scenarios?.bull, cVal * 1.1),
          bear: safeNumber(existing.scenarios?.bear, cVal * 0.9),
        };
      }
      if (!existing.sheet) existing.sheet = c.sheet;
      if (!existing.cell) existing.cell = c.cell;
      if (!existing.activeCell && c.activeCell) existing.activeCell = c.activeCell;
      if (!existing.aliasId && c.aliasId) existing.aliasId = c.aliasId;
      if (!existing.blockLabel && c.blockLabel) existing.blockLabel = c.blockLabel;
      continue;
    }
    if (Math.abs(cVal) > 0) {
      const newLever: ModelSchemaLever = {
        id: cid,
        label: c.label || c.id,
        type: "input_driver",
        category: "assumption",
        scenarios: { base: cVal, bull: cVal * 1.1, bear: cVal * 0.9 },
        affectsSheets: [c.sheet],
        unit: "value",
        sheet: c.sheet,
        cell: c.cell,
        ...(c.activeCell ? { activeCell: c.activeCell } : {}),
        ...(c.aliasId ? { aliasId: c.aliasId } : {}),
        ...(c.blockLabel ? { blockLabel: c.blockLabel } : {}),
      };
      schema.scenarioLevers.push(newLever);
      leverById.set(cid, newLever);
    }
  }

  for (const c of graph.outputCandidates || []) {
    const cid = toId(c.id || c.label || "metric");
    const cVal = safeNumber(c.value, 0);
    const existing = outputById.get(cid);
    if (existing) {
      if (!existing.cell && c.cell) existing.cell = c.cell;
      if (!existing.sheet) existing.sheet = c.sheet;
      if (!existing.aggregateCell && c.aggregateCell) existing.aggregateCell = c.aggregateCell;
      if (!existing.aliasId && c.aliasId) existing.aliasId = c.aliasId;
    } else if (Math.abs(cVal) > 0) {
      const metric: ModelSchemaOutput = {
        id: cid,
        label: c.label || c.id,
        sheet: c.sheet,
        row: c.row,
        cell: c.cell,
        ...(c.aggregateCell ? { aggregateCell: c.aggregateCell } : {}),
        ...(c.aliasId ? { aliasId: c.aliasId } : {}),
        isKPI: true,
      };
      schema.outputMetrics.push(metric);
      outputById.set(cid, metric);
    }
    const existingVal = safeNumber(schema.baseValues[cid], 0);
    if (Math.abs(existingVal) === 0 && Math.abs(cVal) > 0) {
      schema.baseValues[cid] = cVal;
    }
  }

  // Fill missing/zero baseValues from input candidates (catalog + previously-zero ids).
  for (const c of graph.inputCandidates || []) {
    const cid = toId(c.id || c.label || "input");
    const cVal = safeNumber(c.value, 0);
    const existingVal = safeNumber(schema.baseValues[cid], 0);
    if (Math.abs(existingVal) === 0 && Math.abs(cVal) > 0) {
      schema.baseValues[cid] = cVal;
    }
  }

  return schema;
}

function evaluateExtractionQuality(schema: ModelSchema, graph: WorkbookGraph, iteration: number): ExtractionQualityReport {
  const leverTotal = schema.scenarioLevers.length;
  const leverNonZero = schema.scenarioLevers.filter((l) => Math.abs(safeNumber(l.scenarios?.base, 0)) > 0).length;
  const metricTotal = schema.outputMetrics.length;
  const metricNonZero = schema.outputMetrics.filter((m) => Math.abs(safeNumber(schema.baseValues[m.id], 0)) > 0).length;

  const candidateLeverTotal = (graph.inputCandidates || []).filter((c) => Math.abs(safeNumber(c.value, 0)) > 0).length;
  const candidateMetricTotal = (graph.outputCandidates || []).filter((c) => Math.abs(safeNumber(c.value, 0)) > 0).length;

  let leverMatches = 0;
  for (const c of graph.inputCandidates || []) {
    const cid = toId(c.id || c.label || "input");
    const expected = safeNumber(c.value, 0);
    if (Math.abs(expected) === 0) continue;
    const lever = schema.scenarioLevers.find((l) => toId(l.id) === cid);
    if (lever && Math.abs(safeNumber(lever.scenarios?.base, 0)) > 0) leverMatches++;
  }
  let metricMatches = 0;
  for (const c of graph.outputCandidates || []) {
    const cid = toId(c.id || c.label || "metric");
    const expected = safeNumber(c.value, 0);
    if (Math.abs(expected) === 0) continue;
    if (Math.abs(safeNumber(schema.baseValues[cid], 0)) > 0) metricMatches++;
  }

  const leverPct = leverTotal > 0 ? leverNonZero / leverTotal : 0;
  const metricPct = metricTotal > 0 ? metricNonZero / metricTotal : 0;
  const leverAlignPct = candidateLeverTotal > 0 ? leverMatches / candidateLeverTotal : 1;
  const metricAlignPct = candidateMetricTotal > 0 ? metricMatches / candidateMetricTotal : 1;

  const issues: string[] = [];
  if (leverPct < 0.8) issues.push(`Lever non-zero coverage too low (${leverNonZero}/${leverTotal})`);
  if (metricPct < 0.8) issues.push(`Metric non-zero coverage too low (${metricNonZero}/${metricTotal})`);
  if (leverAlignPct < 0.7) issues.push(`Lever candidate alignment too low (${leverMatches}/${candidateLeverTotal})`);
  if (metricAlignPct < 0.7) issues.push(`Metric candidate alignment too low (${metricMatches}/${candidateMetricTotal})`);
  if (graph.dependencies.length > 0 && metricTotal === 0) issues.push("Dependency graph exists but no output metrics were extracted");

  return {
    iteration,
    leverCoverage: { nonZero: leverNonZero, total: leverTotal, pct: leverPct },
    metricCoverage: { nonZero: metricNonZero, total: metricTotal, pct: metricPct },
    candidateAlignment: {
      leverMatches,
      leverTotal: candidateLeverTotal,
      metricMatches,
      metricTotal: candidateMetricTotal,
    },
    passes: issues.length === 0,
    issues,
  };
}

async function repairModelSchemaWithFeedback(
  schema: ModelSchema,
  graph: WorkbookGraph,
  docName: string,
  report: ExtractionQualityReport,
): Promise<ModelSchema> {
  if (!getApiKey()) return schema;
  const system = `You are repairing a financial ModelSchema extraction.
Return JSON only.
Focus on non-zero value recovery and alignment with workbook candidates.
Do not invent unrealistic values. Prefer candidate values when available.`;
  const userMessage = `Document: ${docName}
Current schema JSON:
${JSON.stringify(schema).slice(0, 100000)}

Workbook candidates:
inputCandidates=${JSON.stringify((graph.inputCandidates || []).slice(0, 1000))}
outputCandidates=${JSON.stringify((graph.outputCandidates || []).slice(0, 1000))}

Quality issues:
${report.issues.map((x) => `- ${x}`).join("\n")}

Repair requirements:
1) Maximize non-zero seeded levers and metrics from candidates.
2) Preserve existing ids when possible; normalize to snake_case.
3) Ensure baseValues has non-zero entries for outputMetrics when candidate exists.
4) Ensure scenarioLevers.base is non-zero when candidate exists.
`;
  const repaired = await callClaudeStructured({
    system,
    userMessage,
    schema: modelSchemaZ,
    toolName: "submit_repaired_schema",
    toolDescription: "Submit the repaired financial model schema",
    temperature: 0.0,
    maxTokens: 2500,
    purpose: "context_build",
  });
  return normalizeModelSchema(repaired, docName, graph);
}

/** Production catalog fallback when no LLM key / LLM fails — exported for acceptance tests. */
export function buildFallbackModelSchema(graph: WorkbookGraph, docName: string): ModelSchema {
  const timeCols = graph.timeAxis?.columns || [];
  const isYearComparison = graph.timeAxis?.kind === "year_comparison";
  const periods = isYearComparison ? 1 : (timeCols.length > 0 ? timeCols.length : 4);
  const granularity = timeCols.some((c) => /q[1-4]/i.test(c)) ? "quarterly" : "monthly";
  const summarySheet = Object.entries(graph.sheets).find(([, s]) => s.role === "summary")?.[0] || Object.keys(graph.sheets)[0] || "Sheet1";

  const scenarioLevers: ModelSchemaLever[] = (graph.inputCandidates || []).slice(0, 20).map((c) => ({
    id: toId(c.id || c.label),
    label: c.label,
    type: "input_driver",
    category: "assumption",
    scenarios: {
      base: safeNumber(c.value, 0),
      bull: safeNumber(c.value, 0) * 1.1,
      bear: safeNumber(c.value, 0) * 0.9,
    },
    affectsSheets: [c.sheet],
    unit: "value",
    sheet: c.sheet,
    cell: c.cell,
    ...(c.activeCell ? { activeCell: c.activeCell } : {}),
    ...(c.aliasId ? { aliasId: c.aliasId } : {}),
    ...(c.blockLabel ? { blockLabel: c.blockLabel } : {}),
  }));
  if (scenarioLevers.length === 0 && graph.scenarioToggle) {
    scenarioLevers.push({
      id: "scenario_selector",
      label: "Scenario Selector",
      type: "selector",
      category: "scenario_driver",
      scenarios: { base: 0, bull: 1, bear: -1 },
      affectsSheets: Object.keys(graph.sheets),
      unit: "index",
    });
  }

  // Rank summary-sheet rows first: derived rows on working schedules (revenue
  // build-ups, cost rosters) far outnumber the P&L's, and a flat truncation
  // would drop the actual reporting lines.
  const summaryRoleSheets = new Set(
    Object.entries(graph.sheets)
      .filter(([, meta]) => meta.role === "summary")
      .map(([name]) => name),
  );
  const rankedOutputs = [...(graph.outputCandidates || [])].sort((a, b) => {
    const aScore = summaryRoleSheets.has(a.sheet) ? 0 : 1;
    const bScore = summaryRoleSheets.has(b.sheet) ? 0 : 1;
    return aScore - bScore;
  });
  const outputMetrics: ModelSchemaOutput[] = rankedOutputs.slice(0, 12).map((c) => ({
    id: toId(c.id || c.label),
    label: c.label,
    sheet: c.sheet || summarySheet,
    row: c.row,
    cell: c.cell,
    ...(c.aggregateCell ? { aggregateCell: c.aggregateCell } : {}),
    ...(c.aliasId ? { aliasId: c.aliasId } : {}),
    isKPI: true,
  }));
  if (outputMetrics.length === 0) {
    outputMetrics.push(
      { id: "revenue", label: "Revenue", sheet: summarySheet, row: 1, isKPI: true },
      { id: "ebitda", label: "EBITDA", sheet: summarySheet, row: 2, isKPI: true },
      { id: "net_income", label: "Net Income", sheet: summarySheet, row: 3, isKPI: true },
    );
  }

  const baseValues: Record<string, number> = {};
  for (const c of graph.outputCandidates || []) {
    baseValues[toId(c.id || c.label)] = safeNumber(c.value, 0);
  }
  for (const c of graph.inputCandidates || []) {
    const id = toId(c.id || c.label);
    const v = safeNumber(c.value, 0);
    if (Math.abs(baseValues[id] ?? 0) === 0 && Math.abs(v) > 0) {
      baseValues[id] = v;
    }
  }

  return {
    company: docName,
    industry: "Unknown",
    currency: graph.currency || "USD",
    unit: graph.unit || "Million",
    fiscalYear: "FY-Current",
    scenarioLevers,
    outputMetrics,
    timeDimension: { granularity, periods, columns: timeCols },
    baseValues,
  };
}

/** @deprecated Use buildFallbackModelSchema */
function fallbackModelSchema(graph: WorkbookGraph, docName: string): ModelSchema {
  return buildFallbackModelSchema(graph, docName);
}

function toModelDefinition(schema: ModelSchema): ModelDefinition {
  // Catalog/summary only — NOT an executable formula DAG for XLSX models.
  // Simulation must use HyperFormula via workbook_snapshot (xlsx_cell_graph).
  // A lever and an output metric commonly share a raw label (e.g. a segment
  // name that appears both as a raw input row and as its own P&L line), which
  // collapses to the same toId() — dedupe ids here so callers keyed by
  // variable id (React lists, lookups) never see two entries with one id.
  const seenIds = new Set<string>();
  const uniqueId = (id: string): string => {
    if (!seenIds.has(id)) {
      seenIds.add(id);
      return id;
    }
    let candidate = `${id}_2`;
    let n = 2;
    while (seenIds.has(candidate)) {
      n += 1;
      candidate = `${id}_${n}`;
    }
    seenIds.add(candidate);
    return candidate;
  };

  const variables = [
    ...schema.scenarioLevers.map((lever) => ({
      id: uniqueId(lever.id),
      name: lever.label,
      formula: String(lever.scenarios?.base ?? 0),
      dependencies: [] as string[],
      tags: ["input", "percent_delta", "xlsx_catalog_only", ...(lever.cell ? [`cell:${lever.sheet}!${lever.cell}`] : [])],
    })),
    ...schema.outputMetrics.map((m) => ({
      id: uniqueId(m.id),
      name: m.label,
      formula: String(schema.baseValues[m.id] ?? 0),
      dependencies: [] as string[],
      tags: ["pl_metric", "output", "xlsx_catalog_only", ...(m.cell ? [`cell:${m.sheet}!${m.cell}`] : [])],
    })),
  ];

  const currentYear = new Date().getFullYear();
  return {
    model_version: `xlsx-${Date.now()}`,
    variables,
    time_horizon: {
      start: `${currentYear}-Q1`,
      end: `${currentYear}-Q4`,
      granularity: schema.timeDimension.granularity === "monthly" ? "monthly" : "quarterly",
    },
  };
}

/** Bounded summary for LLM — excludes dense/sparse cell grids. */
function graphSummaryForLlm(graph: WorkbookGraph): Record<string, unknown> {
  return {
    sheets: graph.sheets,
    dependencies: graph.dependencies.slice(0, 400),
    inputCandidates: graph.inputCandidates,
    outputCandidates: graph.outputCandidates,
    scenarioToggle: graph.scenarioToggle,
    timeAxis: graph.timeAxis,
    currency: graph.currency,
    unit: graph.unit,
    namedRanges: graph.namedRanges,
    largeWorkbook: graph.largeWorkbook,
  };
}

async function llmModelSchema(graph: WorkbookGraph, docName: string): Promise<ModelSchema> {
  if (!getApiKey()) return fallbackModelSchema(graph, docName);

  const system = `You are extracting an XLSX financial model schema from structured workbook graph JSON.
Return JSON only.
Required keys:
company, industry, currency, unit, fiscalYear, scenarioLevers, outputMetrics, timeDimension, baseValues

Rules:
- scenarioLevers must use ids in snake_case and include sheet + cell when known from inputCandidates.
- outputMetrics should include sheet, row, and cell from outputCandidates when available.
- Use numeric defaults for base/bull/bear.
- baseValues and scenarios.base MUST equal the workbook cell values exactly (document-native denomination). Do not rescale Crore→Million or otherwise convert units — denomination is metadata for display only.
- Keep arrays concise and deterministic.`;

  const parsed = await callClaudeStructured({
    system,
    userMessage: `Document name: ${docName}\nWorkbookGraphSummary:\n${JSON.stringify(graphSummaryForLlm(graph)).slice(0, 120000)}`,
    schema: modelSchemaZ,
    toolName: "submit_model_schema",
    toolDescription: "Submit the extracted financial model schema",
    temperature: 0.1,
    maxTokens: 2500,
    purpose: "context_build",
  });
  return normalizeModelSchema(parsed, docName, graph);
}

const businessNarrativeSchema = z.object({
  business_model: z.string().default(""),
  revenue_streams: z.array(z.string()).default([]),
  competitive_landscape: z.string().default(""),
  key_risks: z.array(z.string()).default([]),
});

type BusinessNarrative = z.infer<typeof businessNarrativeSchema>;

/** Heuristic narrative from workbook sheet names + candidate labels when no text docs. */
export function heuristicBusinessNarrative(
  graph: WorkbookGraph,
  company: string,
): BusinessNarrative {
  const sheetNames = Object.keys(graph.sheets || {});
  const labels = [
    ...(graph.inputCandidates || []).map((c) => c.label),
    ...(graph.outputCandidates || []).map((c) => c.label),
  ].filter(Boolean);

  const revenueLike = labels.filter((l) =>
    /revenue|sales|subscription|licensing|service|product/i.test(l),
  );
  const streams = [...new Set(revenueLike.map((l) => l.trim()))].slice(0, 6);

  const modelBits: string[] = [];
  if (sheetNames.some((s) => /volume|plan/i.test(s))) modelBits.push("volume-driven planning");
  if (sheetNames.some((s) => /p&l|profit|income/i.test(s))) modelBits.push("integrated P&L");
  if (sheetNames.some((s) => /assum/i.test(s))) modelBits.push("explicit assumption drivers");

  const business_model =
    modelBits.length > 0
      ? `${company || "Company"} financial model with ${modelBits.join(", ")} (derived from workbook structure).`
      : `${company || "Company"} financial model extracted from spreadsheet structure.`;

  return {
    business_model,
    revenue_streams: streams,
    competitive_landscape: "",
    key_risks: [],
  };
}

async function extractBusinessNarrativeFromText(
  textExcerpt: string,
  companyHint: string,
): Promise<BusinessNarrative | null> {
  if (!textExcerpt.trim() || !getApiKey()) return null;
  try {
    return await callClaudeStructured({
      system: `Extract concise business narrative from document excerpts. Return JSON only.
Focus on business_model (1-2 sentences), revenue_streams, competitive_landscape, key_risks.
Company hint: ${companyHint || "unknown"}`,
      userMessage: textExcerpt.slice(0, 60000),
      schema: businessNarrativeSchema,
      toolName: "submit_business_narrative",
      toolDescription: "Submit business narrative extracted from documents",
      temperature: 0.1,
      maxTokens: 800,
      purpose: "context_build",
    });
  } catch (e) {
    logger.warn({ err: e }, "[ExcelContext] Business narrative LLM extract failed");
    return null;
  }
}

function takeDistributedSlices(text: string, budget: number): string {
  if (text.length <= budget) return text;
  const part = Math.max(200, Math.floor(budget / 3));
  const start = text.slice(0, part);
  const midStart = Math.max(0, Math.floor(text.length / 2) - Math.floor(part / 2));
  const middle = text.slice(midStart, midStart + part);
  const end = text.slice(Math.max(0, text.length - part));
  return `${start}\n...\n${middle}\n...\n${end}`;
}

export async function buildExcelContext(scope: Scope): Promise<CompanyContext> {
  const userId = await resolveUserId(scope.userId);
  const { workspaceId } = scope;
  const docsRes = await pool.query(
    `SELECT document_id, name, workbook_graph, workbook_snapshot, ingestion_report
     FROM documents
     WHERE workspace_id = $1
       AND status = 'ready'
       AND document_kind = 'spreadsheet_model'
     ORDER BY created_at DESC
     LIMIT 1`,
    [workspaceId],
  );
  if (docsRes.rows.length === 0) {
    throw new Error("No processed XLSX model found. Upload an XLSX model first.");
  }

  const doc = docsRes.rows[0] as {
    document_id: string;
    name: string;
    workbook_graph: WorkbookGraph;
    workbook_snapshot: unknown;
    ingestion_report: unknown;
  };
  const workbookGraph = doc.workbook_graph;
  if (!workbookGraph || !workbookGraph.sheets) {
    throw new Error("Workbook graph is not available for the selected XLSX document.");
  }

  // Load companion PDF/text docs for business narrative (keep executable structure from XLSX)
  const textDocsRes = await pool.query(
    `SELECT document_id, name, document_kind
     FROM documents
     WHERE workspace_id = $1
       AND status = 'ready'
       AND document_kind IN ('document_text', 'tabular_data')
     ORDER BY created_at DESC
     LIMIT 20`,
    [workspaceId],
  );
  const textDocIds = textDocsRes.rows.map((r: { document_id: string }) => r.document_id);
  const allSourceIds = [...new Set([doc.document_id, ...textDocIds])];

  let narrative: BusinessNarrative = heuristicBusinessNarrative(workbookGraph, doc.name);
  if (textDocIds.length > 0) {
    const chunks = await getDocumentChunksFromDb(textDocIds);
    const byDoc = new Map<string, string[]>();
    for (const c of chunks) {
      const arr = byDoc.get(c.document_id) || [];
      arr.push(c.text);
      byDoc.set(c.document_id, arr);
    }
    const blocks: string[] = [];
    for (const row of textDocsRes.rows as Array<{ document_id: string; name: string }>) {
      const texts = byDoc.get(row.document_id) || [];
      const joined = texts.join("\n");
      if (!joined.trim()) continue;
      blocks.push(`[Document: ${row.name}]\n${takeDistributedSlices(joined, 8000)}`);
    }
    const excerpt = blocks.join("\n\n").slice(0, 60000);
    const fromLlm = await extractBusinessNarrativeFromText(excerpt, doc.name);
    if (fromLlm && (fromLlm.business_model || fromLlm.revenue_streams.length > 0)) {
      narrative = {
        business_model: fromLlm.business_model || narrative.business_model,
        revenue_streams:
          fromLlm.revenue_streams.length > 0 ? fromLlm.revenue_streams : narrative.revenue_streams,
        competitive_landscape: fromLlm.competitive_landscape || "",
        key_risks: fromLlm.key_risks || [],
      };
    }
  } else {
    // No text docs — optional LLM pass over workbook labels/notes
    const labelBlob = [
      `Company: ${doc.name}`,
      `Sheets: ${Object.keys(workbookGraph.sheets).join(", ")}`,
      `Inputs: ${(workbookGraph.inputCandidates || []).map((c) => c.label).join("; ")}`,
      `Outputs: ${(workbookGraph.outputCandidates || []).map((c) => c.label).join("; ")}`,
    ].join("\n");
    const fromLabels = await extractBusinessNarrativeFromText(labelBlob, doc.name);
    if (fromLabels?.business_model) {
      narrative = {
        ...narrative,
        business_model: fromLabels.business_model,
        revenue_streams:
          fromLabels.revenue_streams.length > 0
            ? fromLabels.revenue_streams
            : narrative.revenue_streams,
        competitive_landscape: fromLabels.competitive_landscape || narrative.competitive_landscape,
        key_risks: fromLabels.key_risks.length > 0 ? fromLabels.key_risks : narrative.key_risks,
      };
    }
  }

  let modelSchema: ModelSchema;
  try {
    modelSchema = await llmModelSchema(workbookGraph, doc.name);
  } catch {
    modelSchema = normalizeModelSchema(fallbackModelSchema(workbookGraph, doc.name), doc.name, workbookGraph);
  }
  modelSchema = enrichFromCandidates(modelSchema, workbookGraph);

  const qualityIterations: ExtractionQualityReport[] = [];
  const MAX_REPAIR_LOOPS = 3;
  for (let i = 1; i <= MAX_REPAIR_LOOPS; i++) {
    const report = evaluateExtractionQuality(modelSchema, workbookGraph, i);
    qualityIterations.push(report);
    if (report.passes) break;
    modelSchema = enrichFromCandidates(modelSchema, workbookGraph);
    if (report.passes) break;
    try {
      modelSchema = await repairModelSchemaWithFeedback(modelSchema, workbookGraph, doc.name, report);
      modelSchema = enrichFromCandidates(modelSchema, workbookGraph);
    } catch {
      // Deterministic enrichment already applied; continue loop.
    }
  }
  const finalQuality = qualityIterations[qualityIterations.length - 1];

  await pool.query(
    `UPDATE documents
     SET model_schema = $1,
         validation_status = 'needs_validation',
         updated_at = NOW()
     WHERE document_id = $2`,
    [JSON.stringify(modelSchema), doc.document_id],
  );

  const contextData = {
    company_name: modelSchema.company,
    industry: modelSchema.industry,
    currency: modelSchema.currency,
    currency_unit: modelSchema.unit,
    business_model: narrative.business_model,
    revenue_streams: narrative.revenue_streams,
    financial_metrics: [],
    competitive_landscape: narrative.competitive_landscape,
    key_risks: narrative.key_risks,
    benchmarks: {},
    model_schema: modelSchema,
    workbook_graph: workbookGraph,
    ingestion_report: doc.ingestion_report || null,
    executable_engine: "xlsx_cell_graph",
    catalog_only_model_definition: true,
    extraction_quality: {
      final: finalQuality,
      iterations: qualityIterations,
    },
    validation_status: "needs_validation",
    usability: "usable" as const,
  };

  await pool.query("UPDATE company_context SET status = 'superseded' WHERE workspace_id = $1 AND status = 'active'", [workspaceId]);
  const ctxInsert = await pool.query(
    `INSERT INTO company_context (created_by, workspace_id, company_name, industry, context_data, source_document_ids, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'active')
     RETURNING *`,
    [userId, workspaceId, modelSchema.company, modelSchema.industry, JSON.stringify(contextData), allSourceIds],
  );

  await pool.query("UPDATE user_models SET is_active = false WHERE workspace_id = $1 AND is_active = true", [workspaceId]);
  const modelDef = toModelDefinition(modelSchema);
  await pool.query(
    `INSERT INTO user_models (created_by, workspace_id, name, model_definition, source_context_id, is_active, source_kind)
     VALUES ($1, $2, $3, $4, $5, true, 'xlsx_catalog')`,
    [userId, workspaceId, `${modelSchema.company} XLSX Model`, JSON.stringify(modelDef), ctxInsert.rows[0].context_id],
  );

  const row = ctxInsert.rows[0];
  return {
    context_id: row.context_id,
    company_name: row.company_name,
    industry: row.industry,
    context_data: row.context_data,
    source_document_ids: row.source_document_ids,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
