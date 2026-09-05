/**
 * Versioned ingestion artifact contracts.
 *
 * WorkbookArtifact  — formula-preserving XLSX structural extract
 * TabularArtifact   — typed single-sheet CSV (data-only, no formulas)
 * IngestionReport   — diagnostics surfaced to analysts before validation
 */

import type { CurrencyUnit } from "./denomination.js";
import type { WorkbookGraph } from "./excelExtractor.js";

export const ARTIFACT_VERSION = 2 as const;

export type IngestionWarningCode =
  | "external_workbook_link"
  | "unsupported_formula_hint"
  | "quoted_sheet_ref"
  | "large_workbook"
  | "missing_formula_result"
  | "sparse_snapshot"
  | "csv_data_only"
  | "parse_fallback"
  | "volatile_function"
  | "named_range_skipped"
  | "unsupported_function"
  | "structured_reference"
  | "array_formula"
  | "pivot_static"
  | "macro_not_executed";

export interface IngestionWarning {
  code: IngestionWarningCode;
  message: string;
  sheet?: string;
  cell?: string;
  detail?: string;
}

/**
 * Sparse cell: `v` is the HyperFormula input (formula string or literal).
 * `expected` is Excel's cached formula result for fidelity reconciliation.
 * `volatile` marks RAND/NOW/TODAY (and dependents) — excluded from fidelity checks.
 * `is_formula` distinguishes real Excel formulas from documentation notes that
 * happen to start with `=` (HyperFormula would otherwise try to parse them).
 */
export interface SparseCell {
  r: number;
  c: number;
  v: string | number;
  expected?: number;
  /**
   * Excel's cached result when it is an error literal (#REF!, #DIV/0!, …).
   * `expected` only ever holds numbers, so without this an error in the source
   * workbook is indistinguishable from a formula that was simply never cached.
   */
  cached_error?: string;
  source_unit?: string;
  source_currency?: string;
  volatile?: boolean;
  /** True when extracted from an Excel formula cell; false for =prefixed text notes. */
  is_formula?: boolean;
}

/** Sparse cell grid: only non-empty cells stored; densified for HyperFormula. */
export interface SparseSheetSnapshot {
  rows: number;
  cols: number;
  cells: SparseCell[];
}

export interface SparseWorkbookSnapshot {
  format: "sparse_v1";
  sheets: Record<string, SparseSheetSnapshot>;
  sheetOrder: string[];
  cellCount: number;
  formulaCount: number;
}

/** Evidence for content-based spreadsheet_model vs tabular_data routing. */
export interface ClassificationEvidence {
  has_formulas: boolean;
  has_scenario_toggles: boolean;
  has_assumption_sheets: boolean;
  formula_count: number;
  assumption_sheet_names: string[];
  reason: string;
}

export interface WorkbookArtifact {
  artifact_version: typeof ARTIFACT_VERSION;
  kind: "workbook";
  sheetOrder: string[];
  graph: WorkbookGraph;
  /** Runtime snapshot kept separate from graph metadata when persisted. */
  snapshot: SparseWorkbookSnapshot | null;
  currency?: string;
  unit?: CurrencyUnit | string;
  warnings: IngestionWarning[];
  stats: {
    sheetCount: number;
    formulaCount: number;
    crossSheetLinkCount: number;
    cellCount: number;
    namedRangeCount: number;
  };
}

export interface TabularColumn {
  name: string;
  index: number;
  inferredType: "number" | "string" | "empty";
}

export interface TabularArtifact {
  artifact_version: typeof ARTIFACT_VERSION;
  kind: "tabular";
  /** Synthetic single sheet — CSV has no multi-worksheet linkage. */
  sheetName: string;
  headers: string[];
  columns: TabularColumn[];
  rowCount: number;
  /** Sample of typed rows (capped) for context; full text goes to chunks. */
  sampleRows: Array<Record<string, string | number | null>>;
  delimiter: string;
  encoding: "utf-8";
  currency?: string;
  unit?: CurrencyUnit | string;
  dataOnly: true;
  warnings: IngestionWarning[];
}

export interface IngestionReport {
  artifact_version: typeof ARTIFACT_VERSION;
  document_kind: "spreadsheet_model" | "tabular_data" | "document_text";
  parser: "local" | "llamaparse";
  currency?: string;
  unit?: string;
  sheetCount: number;
  formulaCount: number;
  crossSheetLinkCount: number;
  cellCount: number;
  namedRangeCount: number;
  warnings: IngestionWarning[];
  executable: boolean;
  summary: string;
  /** Why spreadsheet_model vs tabular_data was chosen (XLSX content routing). */
  classification_evidence?: ClassificationEvidence;
}

/**
 * Heuristic: does an `=`-prefixed string look like an Excel formula (vs a note)?
 * Used for legacy snapshots that lack `is_formula`, and as a safety net.
 */
export function looksLikeExcelFormula(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("=")) return false;
  const body = trimmed.slice(1).trim();
  if (!body) return false;
  // Function call: SUM(, IF(, VLOOKUP(, …
  if (/\b[A-Z][A-Z0-9._]*\s*\(/i.test(body)) return true;
  // Sheet!A1 or 'P&L'!$B$2
  if (/(?:'[^']+'|[A-Za-z_][\w.]*)!\$?[A-Z]{1,3}\$?\d+/i.test(body)) return true;
  // Bare A1 / $B$2 (not identifiers like Volume_MT alone)
  if (/(?:^|[^A-Za-z0-9_])\$?[A-Z]{1,3}\$?\d+\b/i.test(body)) return true;
  // Pure numeric / arithmetic
  if (/^[\d.\s+\-*/^()%,]+$/.test(body)) return true;
  return false;
}

/** Map Unicode math / dash glyphs Excel often embeds to ASCII operators HF accepts. */
export function normalizeFormulaOperators(formula: string): string {
  return formula
    .replace(/\u2212/g, "-") // − MINUS SIGN
    .replace(/\u2013/g, "-") // – EN DASH
    .replace(/\u2014/g, "-") // — EM DASH
    .replace(/\u00D7/g, "*") // × MULTIPLICATION SIGN
    .replace(/\u00F7/g, "/"); // ÷ DIVISION SIGN
}

/**
 * True when the sparse cell should be treated as a formula for fidelity / HF.
 * Honors explicit `is_formula`; falls back to the Excel-formula heuristic for
 * legacy artifacts that only stored the string.
 */
export function isSparseFormulaCell(cell: SparseCell): boolean {
  if (typeof cell.v !== "string") return false;
  const trimmed = cell.v.trim();
  if (!trimmed.startsWith("=")) return false;
  if (cell.is_formula === true) return true;
  if (cell.is_formula === false) return false;
  return looksLikeExcelFormula(trimmed);
}

/**
 * Prepare a sparse cell value for HyperFormula.buildFromSheets.
 * Documentation notes that start with `=` are apostrophe-escaped so HF treats
 * them as text; real formulas get Unicode operators normalized.
 */
export function toHyperFormulaCellValue(
  cell: SparseCell,
): string | number | null {
  const v = cell.v;
  if (typeof v !== "string") return v;
  if (v.startsWith("'")) return v;
  const trimmed = v.trim();
  if (!trimmed.startsWith("=")) return v;
  if (!isSparseFormulaCell(cell)) {
    // Leading apostrophe: HF stores/returns the text without treating it as a formula.
    return `'${v}`;
  }
  return normalizeFormulaOperators(trimmed.startsWith("=") ? trimmed : `=${trimmed}`);
}

/**
 * Expand sparse snapshot into jagged rows for HyperFormula.buildFromSheets.
 * Rows are retained for address stability, but columns are only allocated up
 * to the last populated cell in each row—never padded to sheet.cols.
 */
export function densifySnapshot(
  sparse: SparseWorkbookSnapshot,
): Record<string, (string | number | null)[][]> {
  const out: Record<string, (string | number | null)[][]> = {};
  for (const name of sparse.sheetOrder) {
    const sheet = sparse.sheets[name];
    if (!sheet) continue;
    const grid: (string | number | null)[][] = Array.from(
      { length: sheet.rows },
      () => [],
    );
    for (const cell of sheet.cells) {
      while (grid.length <= cell.r) grid.push([]);
      const row = grid[cell.r];
      while (row.length <= cell.c) row.push(null);
      row[cell.c] = toHyperFormulaCellValue(cell);
    }
    out[name] = grid;
  }
  return out;
}

/** Attach densified cellSnapshot onto a WorkbookGraph for runtime consumers. */
export function graphWithSnapshot(
  graph: WorkbookGraph,
  sparse: SparseWorkbookSnapshot | null | undefined,
): WorkbookGraph {
  if (graph.cellSnapshot && Object.keys(graph.cellSnapshot).length > 0) {
    return graph;
  }
  if (!sparse || sparse.cellCount === 0) return graph;
  return { ...graph, cellSnapshot: densifySnapshot(sparse) };
}

/**
 * Content-based classification for XLSX workbooks.
 * Extension alone is insufficient — a formula-less dump is tabular_data.
 */
export function classifyWorkbookContent(workbook: WorkbookArtifact): {
  document_kind: "spreadsheet_model" | "tabular_data";
  evidence: ClassificationEvidence;
} {
  const formulaCount = workbook.stats.formulaCount ?? 0;
  const has_formulas = formulaCount > 0;
  const has_scenario_toggles = !!workbook.graph.scenarioToggle;
  const assumption_sheet_names = Object.entries(workbook.graph.sheets || {})
    .filter(([, meta]) => meta.role === "assumptions")
    .map(([name]) => name);
  const has_assumption_sheets = assumption_sheet_names.length > 0;

  const isModel = has_formulas || has_scenario_toggles || has_assumption_sheets;
  let reason: string;
  if (has_formulas) {
    reason = `Has ${formulaCount} formula cell(s) — treated as executable spreadsheet model`;
  } else if (has_scenario_toggles) {
    reason = "Has scenario toggle(s) — treated as spreadsheet model";
  } else if (has_assumption_sheets) {
    reason = `Has assumption sheet(s): ${assumption_sheet_names.join(", ")} — treated as spreadsheet model`;
  } else {
    reason = "No formulas, scenario toggles, or assumption sheets — treated as tabular data dump";
  }

  return {
    document_kind: isModel ? "spreadsheet_model" : "tabular_data",
    evidence: {
      has_formulas,
      has_scenario_toggles,
      has_assumption_sheets,
      formula_count: formulaCount,
      assumption_sheet_names,
      reason,
    },
  };
}

export function buildIngestionReport(opts: {
  document_kind: IngestionReport["document_kind"];
  parser: "local" | "llamaparse";
  workbook?: WorkbookArtifact | null;
  tabular?: TabularArtifact | null;
  classification_evidence?: ClassificationEvidence;
}): IngestionReport {
  const wb = opts.workbook;
  const tab = opts.tabular;
  const warnings = [...(wb?.warnings || []), ...(tab?.warnings || [])];
  const formulaCount = wb?.stats.formulaCount ?? 0;
  const crossSheetLinkCount = wb?.stats.crossSheetLinkCount ?? 0;
  const sheetCount = wb?.stats.sheetCount ?? (tab ? 1 : 0);
  const cellCount = wb?.stats.cellCount ?? tab?.rowCount ?? 0;
  const executable =
    opts.document_kind === "spreadsheet_model" &&
    !!wb?.snapshot &&
    (wb?.snapshot.cellCount ?? 0) > 0;

  const evidence =
    opts.classification_evidence ||
    (wb && opts.document_kind !== "document_text"
      ? classifyWorkbookContent(wb).evidence
      : undefined);

  let summary: string;
  if (opts.document_kind === "spreadsheet_model") {
    summary = `XLSX model: ${sheetCount} sheet(s), ${formulaCount} formula(s), ${crossSheetLinkCount} cross-sheet link(s)`;
  } else if (opts.document_kind === "tabular_data") {
    if (wb) {
      summary = `XLSX tabular dump: ${sheetCount} sheet(s), ${cellCount} cell(s) (no formulas/toggles)`;
    } else {
      summary = `CSV data source: ${tab?.rowCount ?? 0} row(s), ${tab?.headers.length ?? 0} column(s) (no formulas)`;
    }
  } else {
    summary = "Text document (RAG/search only)";
  }

  return {
    artifact_version: ARTIFACT_VERSION,
    document_kind: opts.document_kind,
    parser: opts.parser,
    currency: wb?.currency || tab?.currency,
    unit: wb?.unit || tab?.unit,
    sheetCount,
    formulaCount,
    crossSheetLinkCount,
    cellCount,
    namedRangeCount: wb?.stats.namedRangeCount ?? 0,
    warnings,
    executable,
    summary,
    ...(evidence ? { classification_evidence: evidence } : {}),
  };
}
