import ExcelJS from "exceljs";
import JSZip from "jszip";
import { HyperFormula } from "hyperformula";
import { detectDenominationFromText, normalizeCurrencyUnit, type CurrencyUnit } from "./denomination.js";
import { PARITY_UNSUPPORTED_FUNCTIONS } from "./excelParitySupport.generated.js";
import {
  ARTIFACT_VERSION,
  normalizeFormulaOperators,
  type IngestionWarning,
  type SparseCell,
  type SparseWorkbookSnapshot,
  type WorkbookArtifact,
} from "./ingestionArtifacts.js";

export type SheetRole = "assumptions" | "timeseries" | "lookup" | "summary" | "cover";

export interface WorkbookSheetMeta {
  role: SheetRole;
  timeColumns: string[];
  rowCount: number;
  colCount: number;
  /** Per-sheet denomination when detected from sheet headers/notes. */
  currency?: string;
  unit?: string;
  /** Chart-of-accounts / product-master style sheet — never a source of levers. */
  referenceOnly?: boolean;
  /** 0-based index of the sheet's period-total column, when it has one. */
  aggregateColIndex?: number;
  /**
   * 0-based indices of the sheet's period columns.
   *
   * Comparing values across a row only means something when the cells are the
   * same kind of thing. A cost schedule commonly puts headcount and an annual
   * rate on the same row as twelve monthly amounts; treating that whole row as
   * one series makes the headcount look like an outlier against the costs.
   */
  periodColumnIndices?: number[];
}

export interface WorkbookDependency {
  from: string;
  formula: string;
  readsFrom: string[];
}

/**
 * A labelled row within a section block. `blockLabel` is the most recent section
 * header above the row (e.g. "VOLUME GROWTH ASSUMPTIONS"), which disambiguates
 * repeated row labels across blocks — two "Bullet" rows in different blocks are
 * different drivers, not the same one.
 */
export interface WorkbookInputCandidate {
  id: string;
  label: string;
  sheet: string;
  cell: string;
  value: number;
  /** Section header above this row, when the sheet is organised in blocks. */
  blockLabel?: string;
  /** Bare `toId(label)` — kept as an alias so legacy schemas still resolve. */
  aliasId?: string;
  /** True when the candidate cell holds a formula (never a valid lever). */
  isFormula?: boolean;
  /** "Active" column twin driven by a scenario toggle (e.g. E24 for B24). */
  activeCell?: string;
  /** Cell whose value selects which column `activeCell` resolves to. */
  toggleCell?: string;
}

export interface WorkbookOutputCandidate {
  id: string;
  label: string;
  sheet: string;
  row: number;
  cell?: string;
  value: number;
  blockLabel?: string;
  aliasId?: string;
  isFormula?: boolean;
  /** Workbook's own period-total cell for this row (e.g. P&L!O4 = SUM(C4:N4)). */
  aggregateCell?: string;
}

export interface WorkbookTimeAxis {
  sheet: string;
  columns: string[];
  aggregateCol?: string;
  /** Year-over-year comparison columns (FY25/FY24) are not forecast periods. */
  kind?: "periods" | "year_comparison";
  /** Primary (current) year column when kind === "year_comparison". */
  primaryColumn?: string;
}

export interface WorkbookGraph {
  sheets: Record<string, WorkbookSheetMeta>;
  dependencies: WorkbookDependency[];
  inputCandidates?: WorkbookInputCandidate[];
  outputCandidates?: WorkbookOutputCandidate[];
  scenarioToggle?: { cell: string; values: string[] };
  timeAxis?: WorkbookTimeAxis;
  /**
   * Every per-sheet time-axis candidate, so the chosen axis is auditable and a
   * later re-bind can switch sheets without re-parsing the workbook.
   */
  timeAxisCandidates?: WorkbookTimeAxis[];
  currency?: string;
  unit?: string;
  /** Per-sheet denomination map (sheet name → currency/unit). */
  sheetDenominations?: Record<string, { currency?: string; unit?: string }>;
  namedRanges?: Array<{ name: string; refersTo: string }>;
  /**
   * Dense cell grid (legacy / in-memory). Prefer SparseWorkbookSnapshot in
   * workbook_snapshot column for persistence; densify at runtime.
   */
  cellSnapshot?: Record<string, (string | number | null)[][]>;
  /** Soft flag when workbook is large (still snapshotted sparsely). */
  largeWorkbook?: boolean;
  /** ISO date (YYYY-MM-DD) when the workbook was extracted — for TODAY/NOW explainability. */
  extractionDate?: string;
}

/**
 * Pick the time axis from the sheet that hosts the output metrics.
 *
 * A workbook typically carries several period axes — actuals, plan, cost
 * schedules — and they need not share a calendar. The axis that matters is the
 * one on the sheet whose rows are read as results; any other choice mislabels
 * every period while still producing numbers.
 *
 * Ties (and the no-outputs case) fall back to the widest axis, then to
 * workbook order, so the result is deterministic.
 */
export function selectTimeAxis(
  candidates: WorkbookTimeAxis[],
  outputCandidates: Array<{ sheet: string }>,
  sheetRoles: Record<string, { role: SheetRole }> = {},
): WorkbookTimeAxis | undefined {
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];

  const outputsPerSheet = new Map<string, number>();
  for (const c of outputCandidates) {
    outputsPerSheet.set(c.sheet, (outputsPerSheet.get(c.sheet) ?? 0) + 1);
  }

  let best = candidates[0];
  let bestScore = -1;
  for (const candidate of candidates) {
    // The summary sheet decides the calendar. Intermediate schedules (revenue
    // build-ups, cost rosters) expose more derived rows than the P&L does, so
    // counting rows alone hands the axis to a working sheet.
    const isSummary = sheetRoles[candidate.sheet]?.role === "summary";
    const outputs = outputsPerSheet.get(candidate.sheet) ?? 0;
    const score =
      (isSummary ? 10_000_000 : 0) + outputs * 1000 + candidate.columns.length;
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}

/** Soft threshold for "large workbook" warning — snapshots are still kept. */
export const CELL_SNAPSHOT_WARN_CELLS = 250_000;

const MONTH_REGEX = /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*[-\s']?\d{0,4}\b/i;
const QUARTER_REGEX = /\bq[1-4](?:[-\s]?fy?\s?\d{0,4})?\b/i;
const FY_REGEX = /\bfy[-\s]?\d{2,4}\b/i;
const AGG_COL_REGEX = /\b(total|fy|annual|year)\b/i;

/** Longer than this and the text is a sheet banner, not a column header. */
const MAX_COLUMN_HEADER_CHARS = 60;

/** Aggregating functions that mark a roll-up cell. */
const ROW_AGGREGATE_RE = /\b(SUM|SUBTOTAL|AGGREGATE)\s*\(/i;
/** A1:B2 style range, used to test whether an aggregate stays within one row. */
const RANGE_RE = /\$?([A-Z]{1,3})\$?(\d+)\s*:\s*\$?([A-Z]{1,3})\$?(\d+)/gi;

/**
 * Sheets that are pure reference data — GL charts of accounts, part/product
 * masters. Their "numbers" are identifiers, not quantities, so they must never
 * become scenario levers.
 */
const REFERENCE_SHEET_REGEX = /\b(gl|g\/l|account|accounts|coa|master|reference|ref|lookup|codes?|dictionary|mapping)\b/i;

/** Column headers that mark a scenario variant rather than a period. */
const SCENARIO_COLUMN_REGEX = /^\s*(base|bull|bear|upside|downside|central|best|worst|active|current|plan|budget)\b/i;

/** Header naming the live/selected column of a Base|Bull|Bear|Active block. */
const ACTIVE_COLUMN_REGEX = /^\s*active\b/i;

/**
 * A section header: a row carrying text but no numeric partner, which therefore
 * labels the rows beneath it rather than holding a value of its own.
 * Excel writers frequently repeat the header text across the merged span, so a
 * row whose distinct text is a single value is still a header.
 */
function isSectionHeaderRow(texts: string[], hasNumeric: boolean): boolean {
  if (hasNumeric) return false;
  const distinct = [...new Set(texts.map((t) => t.trim()).filter(Boolean))];
  return distinct.length === 1 && distinct[0].length > 0;
}

/** Strip decoration Excel authors add to section headers ("▶  FY24 PLAN  (units)"). */
export function normalizeBlockLabel(raw: string): string {
  return raw
    .replace(/[▶►▪◆•]/g, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\|.*$/, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 0-based column index → Excel letters (0 → A, 26 → AA). */
export function colIndexToLetters(index: number): string {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/**
 * Reference-style numeric columns: GL codes, part numbers, IDs. These are
 * integers of near-uniform width with no decimals and no repetition of scale —
 * quantities essentially never look like this.
 */
export function looksLikeIdentifierColumn(values: number[]): boolean {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length < 3) return false;
  const allIntegers = finite.every((v) => Number.isInteger(v) && Math.abs(v) >= 1000);
  if (!allIntegers) return false;
  const widths = new Set(finite.map((v) => String(Math.abs(v)).length));
  return widths.size <= 2;
}

/** Filler words that add nothing when a block label qualifies a row label. */
const BLOCK_FILLER_REGEX = /\b(assumptions?|inputs?|drivers?|plan|summary|section|details?)\b/gi;

function blockSlug(blockLabel: string): string {
  const trimmed = blockLabel.replace(BLOCK_FILLER_REGEX, " ").replace(/\s+/g, " ").trim();
  return toId(trimmed || blockLabel);
}

interface IdentifiableCandidate {
  id: string;
  aliasId?: string;
  label: string;
  sheet: string;
  cell?: string;
  blockLabel?: string;
}

/**
 * Give every candidate a stable, unique id.
 *
 * Bare `toId(label)` collides whenever a workbook repeats row labels across
 * blocks ("Bullet" under both VOLUME GROWTH and PRICE CHANGE). A collision that
 * survives to the runtime silently binds the wrong cell, so ids are widened —
 * block, then sheet, then cell — only as far as uniqueness requires. The bare
 * id is always retained as `aliasId` so previously stored schemas still resolve.
 */
export function assignCandidateIds<T extends IdentifiableCandidate>(candidates: T[]): T[] {
  const byBareId = new Map<string, T[]>();
  for (const c of candidates) {
    const bare = c.id;
    const group = byBareId.get(bare);
    if (group) group.push(c);
    else byBareId.set(bare, [c]);
  }

  for (const [bare, group] of byBareId) {
    if (group.length === 1) {
      group[0].aliasId = bare;
      continue;
    }
    const widened = group.map((c) => {
      const block = c.blockLabel ? blockSlug(c.blockLabel) : "";
      return block && block !== bare ? `${block}_${bare}` : bare;
    });
    const blockUnique = new Set(widened).size === group.length;
    group.forEach((c, i) => {
      c.aliasId = bare;
      if (blockUnique) {
        c.id = widened[i];
        return;
      }
      const sheetQualified = `${toId(c.sheet)}_${widened[i]}`;
      c.id = sheetQualified;
    });
    // Sheet qualification can still tie (same sheet, same block, same label) —
    // fall back to the cell address, which is unique by construction.
    const seen = new Map<string, number>();
    for (const c of group) {
      const count = (seen.get(c.id) ?? 0) + 1;
      seen.set(c.id, count);
    }
    for (const c of group) {
      if ((seen.get(c.id) ?? 0) > 1 && c.cell) {
        c.id = `${c.id}_${toId(c.cell)}`;
      }
    }
  }

  return candidates;
}
const VOLATILE_FN_REGEX = /\b(RAND|RANDBETWEEN|RANDARRAY|NOW|TODAY)\s*\(/i;
const FUNCTION_TOKEN_REGEX = /(?:_xlfn\.)?([A-Z][A-Z0-9._]*)\s*\(/gi;
const HF_FUNCTIONS = new Set(HyperFormula.getRegisteredFunctionNames("enGB"));

/**
 * Cross-sheet / cell refs including quoted sheet names:
 *   Sheet1!A1, 'P&L Summary'!$B$2, Assumptions!B8
 */
const CELL_REF_REGEX =
  /(?:^|[^A-Za-z0-9_'])(?:'([^']+)'|([A-Za-z0-9_ ]+))!(\$?[A-Z]{1,3}\$?\d+)/gi;

/** External workbook links like [Other.xlsx]Sheet!A1 */
const EXTERNAL_LINK_REGEX = /\[[^\]]+\]/g;

const SCALE_SUFFIXES: Record<string, number> = {
  k: 1e3,
  m: 1e6,
  mn: 1e6,
  mm: 1e6,
  bn: 1e9,
  b: 1e9,
  cr: 1e7,
  l: 1e5,
  lac: 1e5,
  lacs: 1e5,
  lakh: 1e5,
};

export function parseNumericLike(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    let trimmed = value.trim();
    if (!trimmed) return null;

    let negative = false;
    const parenMatch = trimmed.match(/^[^\d(]*\(([^)]+)\)[^\d)]*$/);
    if (parenMatch) {
      negative = true;
      trimmed = parenMatch[1];
    }

    if (/^-?\d+(?:\.\d+)?%$/.test(trimmed)) {
      const pct = Number(trimmed.replace("%", ""));
      if (!Number.isFinite(pct)) return null;
      const v = pct / 100;
      return negative ? -v : v;
    }

    const stripped = trimmed.replace(/^[$₹€£]\s*/, "").replace(/,/g, "");
    const scaleMatch = stripped.match(/^(-?\d+(?:\.\d+)?)\s*([a-zA-Z]{1,4})$/);
    if (scaleMatch) {
      const multiplier = SCALE_SUFFIXES[scaleMatch[2].toLowerCase()];
      if (multiplier) {
        const n = Number(scaleMatch[1]) * multiplier;
        if (!Number.isFinite(n)) return null;
        return negative ? -n : n;
      }
    }

    if (/^-?\d+(?:\.\d+)?$/.test(stripped)) {
      const n = Number(stripped);
      if (!Number.isFinite(n)) return null;
      return negative ? -n : n;
    }
  }
  if (value && typeof value === "object" && "result" in (value as Record<string, unknown>)) {
    const result = (value as { result?: unknown }).result;
    return parseNumericLike(result);
  }
  return null;
}

function normalizeFormula(raw: string): string {
  const trimmed = normalizeFormulaOperators(raw.trim());
  return trimmed.startsWith("=") ? trimmed : `=${trimmed}`;
}

/** Extract formula string from ExcelJS cell (formula prop or value object). */
export function getCellFormula(cell: ExcelJS.Cell): string | null {
  if (cell.formula) return normalizeFormula(String(cell.formula));
  const raw = cell.value;
  if (raw && typeof raw === "object" && !Array.isArray(raw) && !(raw instanceof Date)) {
    const obj = raw as { formula?: string; sharedFormula?: string };
    if (obj.formula) return normalizeFormula(String(obj.formula));
    if (obj.sharedFormula) return normalizeFormula(String(obj.sharedFormula));
  }
  return null;
}

/** ExcelJS cached formula result when present (for fidelity expected values). */
/** Excel error literal cached on a formula cell, if that is what it evaluates to. */
export function getCachedFormulaError(cell: ExcelJS.Cell): string | undefined {
  const candidates: unknown[] = [
    (cell as ExcelJS.Cell & { result?: unknown }).result,
    cell.value,
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (typeof candidate === "string" && /^#[A-Z0-9_/]+[!?]?$/i.test(candidate.trim())) {
      return candidate.trim();
    }
    if (typeof candidate === "object" && !Array.isArray(candidate) && !(candidate instanceof Date)) {
      const obj = candidate as { error?: unknown; result?: unknown };
      if (typeof obj.error === "string") return obj.error.trim();
      if (typeof obj.result === "string" && /^#[A-Z0-9_/]+[!?]?$/i.test(obj.result.trim())) {
        return obj.result.trim();
      }
      if (obj.result && typeof obj.result === "object") {
        const nested = (obj.result as { error?: unknown }).error;
        if (typeof nested === "string") return nested.trim();
      }
    }
  }
  return undefined;
}

export function getCachedFormulaResult(cell: ExcelJS.Cell): number | undefined {
  const fromResultProp = parseNumericLike(
    (cell as ExcelJS.Cell & { result?: unknown }).result,
  );
  if (fromResultProp != null) return fromResultProp;

  const raw = cell.value;
  if (raw && typeof raw === "object" && !Array.isArray(raw) && !(raw instanceof Date)) {
    const obj = raw as { result?: unknown };
    if ("result" in obj) {
      const n = parseNumericLike(obj.result);
      if (n != null) return n;
    }
  }
  return undefined;
}

export function extractReadsFrom(formula: string): string[] {
  const refs: string[] = [];
  CELL_REF_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null = null;
  while ((match = CELL_REF_REGEX.exec(formula)) !== null) {
    const sheet = (match[1] || match[2] || "").trim();
    const cell = match[3].replace(/\$/g, "");
    if (sheet && cell) refs.push(`${sheet}!${cell}`);
  }
  return [...new Set(refs)];
}

function isCrossSheetFormula(formula: string): boolean {
  CELL_REF_REGEX.lastIndex = 0;
  return CELL_REF_REGEX.test(formula);
}

function isTimeHeader(value: string): boolean {
  return MONTH_REGEX.test(value) || QUARTER_REGEX.test(value) || FY_REGEX.test(value);
}

/**
 * Compact period column labels (e.g. "FY25 (₹ Cr)", "Q1 FY25", "Apr-24").
 * Rejects prose titles that merely embed an FY token.
 */
function isPeriodColumnHeader(value: string): boolean {
  const t = value.trim();
  if (!t || t.length > 32) return false;
  if (MONTH_REGEX.test(t) || QUARTER_REGEX.test(t)) return true;
  return /^fy[-\s]?\d{2,4}\b/i.test(t);
}

function classifySheet(
  sheetName: string,
  rowCount: number,
  colCount: number,
  formulaCells: number,
  crossSheetFormulaCells: number,
  textCells: number,
  numericCells: number,
  timeHeaders: string[],
): SheetRole {
  const lowerName = sheetName.toLowerCase();
  if (lowerName.includes("assumption")) return "assumptions";
  if (lowerName.includes("cover")) return "cover";
  if (lowerName.includes("p&l") || lowerName.includes("summary")) return "summary";

  if (timeHeaders.length >= 2 && numericCells > textCells) return "timeseries";
  if (formulaCells > 0 && crossSheetFormulaCells / Math.max(formulaCells, 1) >= 0.5) return "summary";
  if (textCells > numericCells * 1.5 && formulaCells <= 2) return "lookup";
  if (rowCount * colCount <= 25 && numericCells <= 2) return "cover";
  return "lookup";
}

function toId(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function colToLetters(col: number): string {
  let n = col + 1;
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** Render formula-aware text for secondary RAG chunks (does not drive the model). */
export function renderFormulaAwareText(graph: WorkbookGraph, snapshot: SparseWorkbookSnapshot | null): string {
  const lines: string[] = [];
  if (graph.currency || graph.unit) {
    lines.push(`Denomination: ${[graph.currency, graph.unit].filter(Boolean).join(" ")}`);
  }
  const dense = snapshot
    ? Object.fromEntries(
        Object.entries(snapshot.sheets).map(([name, s]) => {
          const grid: (string | number | null)[][] = [];
          for (const cell of s.cells) {
            while (grid.length <= cell.r) grid.push([]);
            const row = grid[cell.r];
            while (row.length <= cell.c) row.push(null);
            row[cell.c] = cell.v;
          }
          return [name, grid] as const;
        }),
      )
    : graph.cellSnapshot || {};

  for (const [sheetName, meta] of Object.entries(graph.sheets)) {
    lines.push(`Sheet: ${sheetName} (role=${meta.role})`);
    const grid = dense[sheetName];
    if (grid) {
      for (let r = 0; r < grid.length; r++) {
        const row = grid[r];
        if (!row) continue;
        const cells: string[] = [];
        for (let c = 0; c < row.length; c++) {
          const v = row[c];
          if (v == null || v === "") continue;
          const col = String.fromCharCode(65 + (c % 26)); // simple A.. for display
          cells.push(`${col}${r + 1}=${v}`);
        }
        if (cells.length > 0) lines.push(`Row ${r + 1}:\t${cells.join("\t")}`);
      }
    }
    lines.push("");
  }

  if (graph.dependencies.length > 0) {
    lines.push("Cross-sheet formulas:");
    for (const dep of graph.dependencies.slice(0, 200)) {
      if (dep.readsFrom.length > 0) {
        lines.push(`${dep.from}: ${dep.formula} ← ${dep.readsFrom.join(", ")}`);
      }
    }
  }
  return lines.join("\n");
}

/**
 * Full structural extract: WorkbookGraph metadata + sparse formula-preserving snapshot.
 */
export async function extractWorkbookArtifact(buffer: Buffer): Promise<WorkbookArtifact> {
  const workbook = new ExcelJS.Workbook();
  const arrayBuffer = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
  await workbook.xlsx.load(arrayBuffer);

  const sheets: Record<string, WorkbookSheetMeta> = {};
  const dependencies: WorkbookDependency[] = [];
  const inputCandidates: NonNullable<WorkbookGraph["inputCandidates"]> = [];
  const outputCandidates: NonNullable<WorkbookGraph["outputCandidates"]> = [];
  const warnings: IngestionWarning[] = [];
  const unsupportedFunctions = new Map<
    string,
    { count: number; examples: string[]; reason: "unregistered" | "parity" }
  >();
  const sheetOrder: string[] = [];
  let scenarioToggle: WorkbookGraph["scenarioToggle"];
  const timeAxisCandidates: WorkbookTimeAxis[] = [];
  let formulaCount = 0;
  let crossSheetLinkCount = 0;
  let cellCount = 0;

  const sparseSheets: SparseWorkbookSnapshot["sheets"] = {};
  const denomTextChunks: string[] = [];
  /** Cells containing volatile functions — dependents marked after dependency walk. */
  const volatileCells = new Set<string>();
  /** ISO date of extraction — for TODAY/NOW explainability in run manifests. */
  const extractionDate = new Date().toISOString().slice(0, 10);

  try {
    const archive = await JSZip.loadAsync(buffer);
    if (Object.keys(archive.files).some((name) => /^xl\/pivot(Cache|Tables)\//i.test(name))) {
      warnings.push({
        code: "pivot_static",
        message: "Pivot tables are imported as cached static values; pivot refresh is not supported.",
      });
    }
    if (archive.file("xl/vbaProject.bin")) {
      warnings.push({
        code: "macro_not_executed",
        message: "VBA macros are preserved in the original workbook but are never executed.",
      });
    }
  } catch {
    // ExcelJS provides the authoritative malformed-workbook error below.
  }

  const namedRanges: Array<{ name: string; refersTo: string }> = [];
  try {
    const definedNames = (workbook as unknown as { definedNames?: { model?: Array<{ name?: string; ranges?: string[] }> } })
      .definedNames;
    const model = definedNames?.model;
    if (Array.isArray(model)) {
      for (const dn of model) {
        if (!dn?.name) continue;
        const refersTo = Array.isArray(dn.ranges) ? dn.ranges.join(",") : String(dn.ranges || "");
        namedRanges.push({ name: dn.name, refersTo });
      }
    }
  } catch {
    // named ranges optional
  }

  workbook.eachSheet((sheet) => {
    sheetOrder.push(sheet.name);
    const timeHeaders: string[] = [];
    let formulaCells = 0;
    let crossSheetFormulaCells = 0;
    let textCells = 0;
    let numericCells = 0;
    let maxCol = 0;
    let maxRow = 0;
    const rowPairs: Array<{
      row: number;
      label: string;
      numericValue: number;
      numericCell: string;
      isFormula: boolean;
      blockLabel?: string;
      activeCell?: string;
      /** Every numeric cell on the row, by column — lets the post-scan pass
       *  below re-target a row bound to the wrong period column. */
      numericByCol?: Map<number, { value: number; cell: string; isFormula: boolean }>;
    }> = [];
    const sparseCells: SparseCell[] = [];
    /** Most recent section header — disambiguates repeated row labels. */
    let currentBlockLabel: string | undefined;
    /** 0-based index of the block's "Active" column, when it has one. */
    let activeColIdx: number | null = null;
    /**
     * Per column, how many formulas aggregate across their own row
     * (`=SUM(F3:Q3)`). This identifies a roll-up column structurally, which
     * beats guessing from header text — "Annual Rate (₹)" reads like a total
     * and is an input, while "FY24 Cost (₹Cr)" reads like a period and is not.
     */
    const rowAggregateCountByCol = new Map<number, number>();
    /**
     * Header texts by column index from the sheet's first three rows. Kept as a
     * list because row 1 is typically a banner repeated across every column,
     * which would otherwise shadow the real header row beneath it.
     */
    const headerTextsByCol = new Map<number, string[]>();

    sheet.eachRow((row, rowNumber) => {
      maxCol = Math.max(maxCol, row.cellCount || 0);
      maxRow = Math.max(maxRow, rowNumber);
      let firstText: string | null = null;
      let firstNumValue: number | null = null;
      let firstNumCell: string | null = null;
      let firstNumIsFormula = false;
      /** All text seen on this row — used to classify header vs data rows. */
      const rowTexts: string[] = [];
      /** Text by column index, for locating the Active column of a block. */
      const rowTextByCol = new Map<number, string>();
      /** Cell address by column index, for resolving the Active cell. */
      const rowAddressByCol = new Map<number, string>();
      /** Every numeric cell on this row, by column. */
      const numericByCol = new Map<number, { value: number; cell: string; isFormula: boolean }>();

      row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
        const raw = cell.value;
        const formula = getCellFormula(cell);
        const rowIdx = rowNumber - 1;
        const colIdx = colNumber - 1;

        let snapshotValue: string | number | null = null;
        if (formula) {
          snapshotValue = formula;
        } else if (typeof raw === "number" && Number.isFinite(raw)) {
          snapshotValue = raw;
        } else if (raw instanceof Date) {
          snapshotValue = raw.toISOString().slice(0, 10);
        } else if (raw != null) {
          const numeric = parseNumericLike(raw);
          if (numeric != null) snapshotValue = numeric;
          else if (typeof raw === "string") snapshotValue = raw;
          else if (typeof raw === "boolean") snapshotValue = raw ? 1 : 0;
          else if (typeof raw === "object" && "text" in (raw as object)) {
            snapshotValue = String((raw as { text: string }).text);
          } else if (typeof raw === "object" && "result" in (raw as object)) {
            const res = (raw as { result?: unknown }).result;
            const n = parseNumericLike(res);
            snapshotValue = n != null ? n : res != null ? String(res) : null;
          }
        }

        if (snapshotValue != null && snapshotValue !== "") {
          const sparseCell: SparseCell = { r: rowIdx, c: colIdx, v: snapshotValue };
          if (formula) {
            sparseCell.is_formula = true;
            const expected = getCachedFormulaResult(cell);
            const cachedError = expected == null ? getCachedFormulaError(cell) : undefined;
            if (expected != null) {
              sparseCell.expected = expected;
            } else if (cachedError) {
              // The workbook itself is in error here; say so rather than
              // reporting it as a merely missing cached value.
              sparseCell.cached_error = cachedError;
              warnings.push({
                code: "missing_formula_result",
                message: `Formula cell evaluates to ${cachedError} in the source workbook`,
                sheet: sheet.name,
                cell: cell.address,
                detail: formula,
              });
            } else {
              warnings.push({
                code: "missing_formula_result",
                message: "Formula cell has no cached Excel result for fidelity reconciliation",
                sheet: sheet.name,
                cell: cell.address,
                detail: formula,
              });
            }
          } else if (typeof snapshotValue === "string" && snapshotValue.trim().startsWith("=")) {
            // Documentation notes that look like formulas — keep as text for HF.
            sparseCell.is_formula = false;
          }
          sparseCells.push(sparseCell);
          cellCount++;
        }

        const displayText =
          typeof raw === "string"
            ? raw.trim()
            : formula
              ? formula
              : raw != null
                ? String((raw as { result?: unknown }).result ?? raw).trim()
                : "";

        if (displayText && rowNumber <= 3 && isTimeHeader(displayText)) {
          timeHeaders.push(displayText);
        }
        if (typeof raw === "string" && raw.trim()) {
          denomTextChunks.push(raw.trim());
        }

        rowAddressByCol.set(colIdx, cell.address);
        if (rowNumber <= 3 && displayText && !formula) {
          const existing = headerTextsByCol.get(colIdx);
          if (existing) existing.push(displayText);
          else headerTextsByCol.set(colIdx, [displayText]);
        }

        const numericLike = parseNumericLike(raw);
        if (numericLike != null) {
          numericCells++;
          numericByCol.set(colIdx, { value: numericLike, cell: cell.address, isFormula: Boolean(formula) });
          if (firstNumValue == null) {
            firstNumValue = numericLike;
            firstNumCell = cell.address;
            firstNumIsFormula = Boolean(formula);
          }
        }
        if (typeof raw === "string" && raw.trim()) {
          textCells++;
          rowTexts.push(raw.trim());
          rowTextByCol.set(colIdx, raw.trim());
          if (!firstText) firstText = raw.trim();
        } else if (!firstText && typeof raw !== "number" && !formula && displayText && !/^-?\d/.test(displayText)) {
          firstText = displayText;
        }

        if (formula) {
          formulaCells++;
          formulaCount++;
          if (ROW_AGGREGATE_RE.test(formula)) {
            for (const m of formula.matchAll(RANGE_RE)) {
              if (Number(m[2]) === rowNumber && Number(m[4]) === rowNumber) {
                rowAggregateCountByCol.set(colIdx, (rowAggregateCountByCol.get(colIdx) ?? 0) + 1);
                break;
              }
            }
          }
          const fromRef = `${sheet.name}!${cell.address}`;
          const readsFrom = extractReadsFrom(formula);
          if (isCrossSheetFormula(formula)) {
            crossSheetFormulaCells++;
            crossSheetLinkCount++;
          }
          if (EXTERNAL_LINK_REGEX.test(formula)) {
            EXTERNAL_LINK_REGEX.lastIndex = 0;
            warnings.push({
              code: "external_workbook_link",
              message: "Formula references an external workbook",
              sheet: sheet.name,
              cell: cell.address,
              detail: formula,
            });
          }
          if (formula.includes("'")) {
            warnings.push({
              code: "quoted_sheet_ref",
              message: "Formula uses quoted sheet name (preserved)",
              sheet: sheet.name,
              cell: cell.address,
            });
          }
          for (const match of formula.matchAll(FUNCTION_TOKEN_REGEX)) {
            const functionName = match[1].toUpperCase();
            const registered = HF_FUNCTIONS.has(functionName);
            const failedParity = PARITY_UNSUPPORTED_FUNCTIONS.has(functionName);
            if (registered && !failedParity) continue;
            const record = unsupportedFunctions.get(functionName) ?? {
              count: 0,
              examples: [],
              reason: failedParity ? "parity" : "unregistered",
            };
            record.count += 1;
            if (record.examples.length < 3) record.examples.push(`${sheet.name}!${cell.address}`);
            unsupportedFunctions.set(functionName, record);
          }
          if (/\b[A-Z_][A-Z0-9_.]*\s*\[[^\]]+\]/i.test(formula)) {
            warnings.push({
              code: "structured_reference",
              message: "Structured table reference requires review",
              sheet: sheet.name,
              cell: cell.address,
              detail: formula.slice(0, 200),
            });
          }
          const formulaType = (cell as unknown as { formulaType?: string }).formulaType;
          if (formulaType === "array" || formulaType === "shared") {
            warnings.push({
              code: "array_formula",
              message: `${formulaType === "array" ? "Array" : "Shared"} formula requires parity review`,
              sheet: sheet.name,
              cell: cell.address,
              detail: formula.slice(0, 200),
            });
          }
          if (VOLATILE_FN_REGEX.test(formula)) {
            VOLATILE_FN_REGEX.lastIndex = 0;
            volatileCells.add(fromRef.replace(/\$/g, "").toUpperCase());
            warnings.push({
              code: "volatile_function",
              message:
                "Volatile function (RAND/NOW/TODAY) — value is non-deterministic vs Excel cached result",
              sheet: sheet.name,
              cell: cell.address,
              detail: formula.slice(0, 120),
            });
          }
          dependencies.push({ from: fromRef, formula, readsFrom });

          if (!scenarioToggle && /IF\(/i.test(formula)) {
            const labels = [...formula.matchAll(/"(Base|Bull|Bear|Upside|Downside|Central|Aggressive|Conservative|S\d+)"/gi)]
              .map((m) => m[1]);
            const uniq = [...new Set(labels.map((v) => v.trim()))];
            if (uniq.length >= 2) {
              // The toggle is the cell the IF *tests*, not the cell holding the
              // IF. Selectors are commonly written sheet-qualified and absolute
              // ('Assumptions'!$B$4); stripping both is what makes the real
              // switch resolvable instead of falling back to a consumer cell.
              const selectorMatch = formula.match(/IF\(([^=<>]+)=/i);
              const selectorRaw = selectorMatch?.[1]?.replace(/\$/g, "").trim() ?? "";
              const qualified = selectorRaw.match(/^(?:'([^']+)'|([A-Za-z0-9_ ]+))!([A-Z]{1,3}\d+)$/i);
              const selectorSheet = qualified ? (qualified[1] || qualified[2]).trim() : sheet.name;
              const selectorCell = qualified ? qualified[3] : selectorRaw;
              scenarioToggle = {
                cell: /^[A-Z]{1,3}\d+$/i.test(selectorCell)
                  ? `${selectorSheet}!${selectorCell.toUpperCase()}`
                  : fromRef,
                values: uniq,
              };
            }
          }
        }
      });

      // Section header: text with no numeric partner, and one distinct string
      // (Excel repeats header text across the merged span).
      if (isSectionHeaderRow(rowTexts, firstNumValue != null)) {
        currentBlockLabel = normalizeBlockLabel(rowTexts[0]) || undefined;
        activeColIdx = null;
        return;
      }

      // Column-header row of a block ("Model Family | Base | Bull | Bear | Active").
      // Locates the live column that the workbook's formulas actually read.
      if (firstNumValue == null && rowTexts.length > 1) {
        let foundActive: number | null = null;
        let scenarioCols = 0;
        for (const [colIdx, text] of rowTextByCol) {
          if (SCENARIO_COLUMN_REGEX.test(text)) scenarioCols++;
          if (ACTIVE_COLUMN_REGEX.test(text) && foundActive == null) foundActive = colIdx;
        }
        // Only trust an Active column inside a genuine scenario-variant block.
        activeColIdx = foundActive != null && scenarioCols >= 2 ? foundActive : null;
        return;
      }

      if (firstText && firstNumValue != null && firstNumCell) {
        const activeCell =
          activeColIdx != null ? rowAddressByCol.get(activeColIdx) : undefined;
        rowPairs.push({
          row: rowNumber,
          label: firstText,
          numericValue: firstNumValue,
          numericCell: firstNumCell,
          isFormula: firstNumIsFormula,
          ...(currentBlockLabel ? { blockLabel: currentBlockLabel } : {}),
          ...(activeCell && activeCell !== firstNumCell ? { activeCell } : {}),
          numericByCol,
        });
      }
    });

    const role = classifySheet(
      sheet.name,
      maxRow || sheet.rowCount,
      maxCol,
      formulaCells,
      crossSheetFormulaCells,
      textCells,
      numericCells,
      timeHeaders,
    );
    // The workbook's own period-total column (e.g. P&L "FY24 Total" = SUM(C4:N4)).
    // Reading it beats re-summing evaluated periods, which double-counts whenever
    // the extracted period set does not exactly match the workbook's own.
    // Scanned over every header cell: the period-column filter drops "FY24 Total"
    // before it can be matched, which is why it was previously never found.
    let aggregateColIdx: number | null = null;
    let aggregateColHeader: string | undefined;

    // Structural signal first: the column that sums across its own row.
    const rollupCols = [...rowAggregateCountByCol.entries()]
      .filter(([, count]) => count >= 2)
      .sort((a, b) => b[1] - a[1] || b[0] - a[0]);
    if (rollupCols.length > 0) {
      aggregateColIdx = rollupCols[0][0];
      aggregateColHeader = (headerTextsByCol.get(aggregateColIdx) ?? []).find(
        (t) => t.length <= MAX_COLUMN_HEADER_CHARS,
      );
    }

    for (const [colIdx, texts] of [...headerTextsByCol].sort((a, b) => a[0] - b[0])) {
      if (aggregateColIdx != null) break;
      const match = texts.find(
        (text) =>
          AGG_COL_REGEX.test(text) &&
          // A banner spanning the sheet is not a column header.
          text.length <= MAX_COLUMN_HEADER_CHARS &&
          (/\b(total|annual)\b/i.test(text) || !isPeriodColumnHeader(text)),
      );
      if (!match) continue;
      aggregateColIdx = colIdx;
      aggregateColHeader = match;
      break;
    }

    const periodColumnIndices: number[] = [];
    for (const [colIdx, texts] of [...headerTextsByCol].sort((a, b) => a[0] - b[0])) {
      if (colIdx === aggregateColIdx) continue;
      // A roll-up column is not a period, however its header reads. Including
      // one makes every row look like it has a value twelve times the rest.
      if ((rowAggregateCountByCol.get(colIdx) ?? 0) > 0) continue;
      const usable = texts.filter((t) => t.length <= MAX_COLUMN_HEADER_CHARS);
      if (usable.some((t) => /\b(total|cumulative|ytd)\b/i.test(t))) continue;
      if (usable.some((t) => isPeriodColumnHeader(t))) periodColumnIndices.push(colIdx);
    }

    // A row-level candidate is normally bound to the first numeric cell
    // scanned left to right — right for a sheet that puts the current period
    // beside the label. A calc-flow sheet (base -> growth% -> forex% ->
    // result, e.g. FY24 anchor | driver | driver | FY25 total) puts the
    // current-year result *after* those driver columns, so "first numeric
    // cell" silently lands on the prior year. Re-target only rows whose
    // selected cell is itself a formula (a computed result, never a literal
    // input lever) to whichever recognised period column carries the higher
    // fiscal year — this is what stopped Cipla's "Total revenue" row from
    // reading its FY24 column while every other output on the same workbook
    // read FY25, which had manufactured a revenue figure that silently
    // disagreed with the rest of the P&L.
    if (periodColumnIndices.length >= 2) {
      const colFiscalYear = (colIdx: number): number | null => {
        for (const text of headerTextsByCol.get(colIdx) ?? []) {
          const match = text.match(FY_REGEX);
          const digits = match?.[0].match(/\d+/)?.[0];
          if (digits) return digits.length === 2 ? 2000 + Number(digits) : Number(digits);
        }
        return null;
      };
      const yearByCol = new Map<number, number>();
      for (const colIdx of periodColumnIndices) {
        const year = colFiscalYear(colIdx);
        if (year != null) yearByCol.set(colIdx, year);
      }
      if (yearByCol.size >= 2) {
        const currentColIdx = [...yearByCol.entries()].sort((a, b) => b[1] - a[1])[0][0];
        for (const pair of rowPairs) {
          if (!pair.isFormula) continue;
          const current = pair.numericByCol?.get(currentColIdx);
          if (current && current.cell !== pair.numericCell) {
            pair.numericValue = current.value;
            pair.numericCell = current.cell;
            pair.isFormula = current.isFormula;
          }
        }
      }
    }

    sheets[sheet.name] = {
      role,
      timeColumns: [...new Set(timeHeaders)],
      rowCount: maxRow || sheet.rowCount,
      colCount: maxCol,
      ...(aggregateColIdx != null ? { aggregateColIndex: aggregateColIdx } : {}),
      ...(periodColumnIndices.length > 0 ? { periodColumnIndices } : {}),
    };

    // Per-sheet denomination from the first few rows of labels/notes
    {
      const sheetHintChunks: string[] = [];
      sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        if (rowNumber > 8) return;
        row.eachCell({ includeEmpty: false }, (cell) => {
          if (typeof cell.value === "string" && cell.value.trim()) {
            sheetHintChunks.push(cell.value.trim());
          }
        });
      });
      if (sheetHintChunks.length > 0) {
        const sheetDenom = detectDenominationFromText(sheetHintChunks.join("\n"));
        if (sheetDenom.currency || sheetDenom.unit) {
          sheets[sheet.name].currency = sheetDenom.currency;
          sheets[sheet.name].unit = sheetDenom.unit;
        }
      }
    }

    sparseSheets[sheet.name] = {
      rows: Math.max(maxRow, 1),
      cols: Math.max(maxCol, 1),
      cells: sparseCells,
    };

    // Reference sheets hold identifiers (GL codes, part numbers), not quantities.
    // Treating those as levers produced dozens of dead drivers with bases like
    // 214510 — a GL account number presented to the user as a value to flex.
    const isReferenceSheet =
      role === "lookup" &&
      (REFERENCE_SHEET_REGEX.test(sheet.name.replace(/[_\-.]+/g, " ")) ||
        // Identifier-shaped numbers are only reference data when the sheet
        // carries no denomination. A price list looks identifier-shaped too
        // (₹114,411 / ₹175,000), and those are genuine levers.
        (looksLikeIdentifierColumn(rowPairs.map((pair) => pair.numericValue)) &&
          !sheets[sheet.name].currency));
    if (isReferenceSheet) {
      sheets[sheet.name].referenceOnly = true;
    }

    const aggregateCellFor = (row: number): string | undefined =>
      aggregateColIdx != null ? `${colIndexToLetters(aggregateColIdx)}${row}` : undefined;

    const pushOutput = (pair: (typeof rowPairs)[number], id: string) => {
      const aggregateCell = aggregateCellFor(pair.row);
      outputCandidates.push({
        id,
        label: pair.label,
        sheet: sheet.name,
        row: pair.row,
        cell: pair.numericCell,
        value: pair.numericValue,
        isFormula: pair.isFormula,
        ...(pair.blockLabel ? { blockLabel: pair.blockLabel } : {}),
        ...(aggregateCell ? { aggregateCell } : {}),
      });
    };

    const isSummarySheet = role === "summary" || /p&l|profit|income|summary/i.test(sheet.name);

    if (!isReferenceSheet && (role === "assumptions" || role === "lookup" || role === "timeseries")) {
      for (const pair of rowPairs.slice(0, 30)) {
        const id = toId(pair.label);
        if (!id) continue;
        // A formula cell is a computed result, never an input: writing a scenario
        // value into one overwrites the model's own arithmetic. Such rows are
        // still worth reporting, so they become derived outputs instead.
        if (pair.isFormula) {
          if (!isSummarySheet) pushOutput(pair, id);
          continue;
        }
        inputCandidates.push({
          id,
          label: pair.label,
          sheet: sheet.name,
          cell: pair.numericCell,
          value: pair.numericValue,
          isFormula: false,
          ...(pair.blockLabel ? { blockLabel: pair.blockLabel } : {}),
          ...(pair.activeCell ? { activeCell: pair.activeCell } : {}),
        });
      }
    }
    if (isSummarySheet) {
      for (const pair of rowPairs.slice(0, 20)) {
        const id = toId(pair.label);
        if (!id) continue;
        pushOutput(pair, id);
      }
    }

    // Prefer compact period column headers so prose titles with an embedded FY
    // token (e.g. cover sheets) do not steal the time axis from FY25/FY24 cols.
    const periodCols = [...new Set(timeHeaders.filter(isPeriodColumnHeader))];
    if (periodCols.length >= 2) {
      const hasMonthOrQuarter = periodCols.some(
        (h) => MONTH_REGEX.test(h) || QUARTER_REGEX.test(h),
      );
      const fyCols = periodCols.filter((h) => FY_REGEX.test(h));
      const aggregateHeader = aggregateColHeader;
      if (!hasMonthOrQuarter && fyCols.length >= 1) {
        timeAxisCandidates.push({
          sheet: sheet.name,
          columns: periodCols,
          kind: "year_comparison",
          primaryColumn: fyCols[0],
        });
      } else {
        timeAxisCandidates.push({
          sheet: sheet.name,
          columns: periodCols,
          kind: "periods",
          aggregateCol: aggregateHeader ?? periodCols.find((h) => AGG_COL_REGEX.test(h)),
        });
      }
    }
  });

  assignCandidateIds(inputCandidates);
  assignCandidateIds(outputCandidates);

  // Choose the time axis from the sheet the outputs actually live on.
  //
  // The previous rule was first-sheet-wins in workbook order, which on a model
  // whose actuals sheet precedes its P&L labelled every P&L period with the
  // prior year's month. Column indices still lined up, so nothing failed loudly —
  // the entire result was just off by a year.
  const timeAxis = selectTimeAxis(timeAxisCandidates, outputCandidates, sheets);

  const unsupportedEntries = [...unsupportedFunctions.entries()].sort();
  for (const [functionName, record] of unsupportedEntries.slice(0, 100)) {
    warnings.push({
      code: "unsupported_function",
      message:
        record.reason === "parity"
          ? `${functionName} failed Excel compatibility validation (${record.count} occurrence${record.count === 1 ? "" : "s"}).`
          : `${functionName} is not registered by HyperFormula (${record.count} occurrence${record.count === 1 ? "" : "s"}).`,
      detail: `Examples: ${record.examples.join(", ")}`,
    });
  }
  if (unsupportedEntries.length > 100) {
    warnings.push({
      code: "unsupported_function",
      message: `${unsupportedEntries.length - 100} additional unsupported function names were omitted from this report.`,
    });
  }

  const denom = detectDenominationFromText(denomTextChunks.join("\n"));
  const currency = denom.currency;
  const unit = denom.unit || normalizeCurrencyUnit(denomTextChunks.join(" "));

  // Stamp per-cell source denomination, preferring per-sheet hints over document-global.
  // Candidate values stay in document-native denomination (Crore/MT/₹/t) — unit is metadata only.
  for (const sheetName of sheetOrder) {
    const snap = sparseSheets[sheetName];
    if (!snap) continue;
    const sheetMeta = sheets[sheetName];
    const sheetUnit = (sheetMeta?.unit as CurrencyUnit | undefined) ?? (unit as CurrencyUnit | undefined);
    const sheetCurrency = sheetMeta?.currency ?? currency;
    for (const cell of snap.cells) {
      if (typeof cell.v === "number" && Number.isFinite(cell.v)) {
        if (sheetUnit) cell.source_unit = sheetUnit;
        if (sheetCurrency) cell.source_currency = sheetCurrency;
      }
    }
  }

  // Propagate volatile flag to formula dependents (fixpoint).
  // extractReadsFrom only captures cross-sheet refs — also match same-sheet A1 refs.
  const SAME_SHEET_REF = /(?:^|[^A-Z0-9_!'"])(\$?[A-Z]{1,3}\$?\d+)/gi;
  if (volatileCells.size > 0) {
    let grown = true;
    while (grown) {
      grown = false;
      for (const dep of dependencies) {
        const fromKey = dep.from.replace(/\$/g, "").toUpperCase();
        if (volatileCells.has(fromKey)) continue;
        const sheetOfFrom = fromKey.includes("!") ? fromKey.split("!")[0] : "";
        const readsVolatile = dep.readsFrom.some((r) =>
          volatileCells.has(r.replace(/\$/g, "").toUpperCase()),
        );
        let sameSheetVolatile = false;
        if (!readsVolatile && sheetOfFrom) {
          SAME_SHEET_REF.lastIndex = 0;
          let m: RegExpExecArray | null;
          while ((m = SAME_SHEET_REF.exec(dep.formula)) !== null) {
            const cellRef = m[1].replace(/\$/g, "").toUpperCase();
            if (volatileCells.has(`${sheetOfFrom}!${cellRef}`)) {
              sameSheetVolatile = true;
              break;
            }
          }
        }
        if (readsVolatile || sameSheetVolatile) {
          volatileCells.add(fromKey);
          grown = true;
        }
      }
    }
    for (const sheetName of sheetOrder) {
      const snap = sparseSheets[sheetName];
      if (!snap) continue;
      for (const cell of snap.cells) {
        const a1 = `${colToLetters(cell.c)}${cell.r + 1}`;
        const key = `${sheetName}!${a1}`.toUpperCase();
        if (volatileCells.has(key)) cell.volatile = true;
      }
    }
  }

  const largeWorkbook = cellCount > CELL_SNAPSHOT_WARN_CELLS;
  if (largeWorkbook) {
    warnings.push({
      code: "large_workbook",
      message: `Workbook has ${cellCount} non-empty cells (soft warn threshold ${CELL_SNAPSHOT_WARN_CELLS}); sparse snapshot retained`,
    });
  }
  warnings.push({
    code: "sparse_snapshot",
    message: "Cell snapshot stored in sparse format to preserve formulas at any size",
  });

  // Deduplicate noisy quoted_sheet_ref warnings (keep first 20)
  const deduped: IngestionWarning[] = [];
  const seen = new Set<string>();
  for (const w of warnings) {
    const key = `${w.code}:${w.sheet}:${w.cell}:${w.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(w);
    if (deduped.length >= 100) break;
  }

  const snapshot: SparseWorkbookSnapshot = {
    format: "sparse_v1",
    sheets: sparseSheets,
    sheetOrder,
    cellCount,
    formulaCount,
  };

  const graph: WorkbookGraph = {
    sheets,
    dependencies,
    ...(inputCandidates.length > 0 ? { inputCandidates } : {}),
    ...(outputCandidates.length > 0 ? { outputCandidates } : {}),
    ...(scenarioToggle ? { scenarioToggle } : {}),
    ...(timeAxis ? { timeAxis } : {}),
    ...(timeAxisCandidates.length > 0 ? { timeAxisCandidates } : {}),
    ...(currency ? { currency } : {}),
    ...(unit ? { unit } : {}),
    ...(namedRanges.length > 0 ? { namedRanges } : {}),
    ...(largeWorkbook ? { largeWorkbook: true } : {}),
    extractionDate,
    sheetDenominations: Object.fromEntries(
      Object.entries(sheets)
        .filter(([, meta]) => meta.currency || meta.unit)
        .map(([name, meta]) => [name, { currency: meta.currency, unit: meta.unit }]),
    ),
  };

  return {
    artifact_version: ARTIFACT_VERSION,
    kind: "workbook",
    sheetOrder,
    graph,
    snapshot,
    currency,
    unit,
    warnings: deduped,
    stats: {
      sheetCount: sheetOrder.length,
      formulaCount,
      crossSheetLinkCount,
      cellCount,
      namedRangeCount: namedRanges.length,
    },
  };
}

/**
 * Backward-compatible extract: returns WorkbookGraph with densified cellSnapshot
 * for callers/tests that expect the previous shape.
 */
export async function extractWorkbookGraph(buffer: Buffer): Promise<WorkbookGraph> {
  const artifact = await extractWorkbookArtifact(buffer);
  const { densifySnapshot } = await import("./ingestionArtifacts.js");
  return {
    ...artifact.graph,
    cellSnapshot: artifact.snapshot ? densifySnapshot(artifact.snapshot) : undefined,
  };
}
