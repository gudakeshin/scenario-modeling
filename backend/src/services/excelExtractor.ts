import ExcelJS from "exceljs";
import { detectDenominationFromText, normalizeCurrencyUnit, toCanonical, type CurrencyUnit } from "./denomination.js";
import {
  ARTIFACT_VERSION,
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
}

export interface WorkbookDependency {
  from: string;
  formula: string;
  readsFrom: string[];
}

export interface WorkbookGraph {
  sheets: Record<string, WorkbookSheetMeta>;
  dependencies: WorkbookDependency[];
  inputCandidates?: Array<{ id: string; label: string; sheet: string; cell: string; value: number }>;
  outputCandidates?: Array<{ id: string; label: string; sheet: string; row: number; cell?: string; value: number }>;
  scenarioToggle?: { cell: string; values: string[] };
  timeAxis?: { sheet: string; columns: string[]; aggregateCol?: string };
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
}

/** Soft threshold for "large workbook" warning — snapshots are still kept. */
export const CELL_SNAPSHOT_WARN_CELLS = 250_000;

const MONTH_REGEX = /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*[-\s']?\d{0,4}\b/i;
const QUARTER_REGEX = /\bq[1-4](?:[-\s]?fy?\s?\d{0,4})?\b/i;
const FY_REGEX = /\bfy[-\s]?\d{2,4}\b/i;
const AGG_COL_REGEX = /\b(total|fy|annual|year)\b/i;

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
  const trimmed = raw.trim();
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
  const sheetOrder: string[] = [];
  let scenarioToggle: WorkbookGraph["scenarioToggle"];
  let timeAxis: WorkbookGraph["timeAxis"];
  let currency: string | undefined;
  let unit: string | undefined;
  let formulaCount = 0;
  let crossSheetLinkCount = 0;
  let cellCount = 0;

  const sparseSheets: SparseWorkbookSnapshot["sheets"] = {};
  const denomTextChunks: string[] = [];

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
    const rowPairs: Array<{ row: number; label: string; numericValue: number; numericCell: string }> = [];
    const sparseCells: SparseCell[] = [];

    sheet.eachRow((row, rowNumber) => {
      maxCol = Math.max(maxCol, row.cellCount || 0);
      maxRow = Math.max(maxRow, rowNumber);
      let firstText: string | null = null;
      let firstNumValue: number | null = null;
      let firstNumCell: string | null = null;

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
            const expected = getCachedFormulaResult(cell);
            if (expected != null) {
              sparseCell.expected = expected;
            } else {
              warnings.push({
                code: "missing_formula_result",
                message: "Formula cell has no cached Excel result for fidelity reconciliation",
                sheet: sheet.name,
                cell: cell.address,
                detail: formula,
              });
            }
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

        const numericLike = parseNumericLike(raw);
        if (numericLike != null) {
          numericCells++;
          if (firstNumValue == null) {
            firstNumValue = numericLike;
            firstNumCell = cell.address;
          }
        }
        if (typeof raw === "string" && raw.trim()) {
          textCells++;
          if (!firstText) firstText = raw.trim();
        } else if (!firstText && typeof raw !== "number" && !formula && displayText && !/^-?\d/.test(displayText)) {
          firstText = displayText;
        }

        if (formula) {
          formulaCells++;
          formulaCount++;
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
          // Heuristic for Excel-only functions HyperFormula may not support
          if (/\b(XLOOKUP|FILTER|SORT|UNIQUE|LAMBDA|LET|SEQUENCE|TEXTJOIN)\s*\(/i.test(formula)) {
            warnings.push({
              code: "unsupported_formula_hint",
              message: "Formula may use Excel functions with limited HyperFormula support",
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
              const selectorMatch = formula.match(/IF\(([^=]+)=/i);
              const selectorCell = selectorMatch?.[1]?.replace(/\$/g, "").trim();
              scenarioToggle = {
                cell: selectorCell && /^[A-Z]{1,3}\d+$/i.test(selectorCell)
                  ? `${sheet.name}!${selectorCell}`
                  : fromRef,
                values: uniq,
              };
            }
          }
        }
      });

      if (firstText && firstNumValue != null && firstNumCell) {
        rowPairs.push({
          row: rowNumber,
          label: firstText,
          numericValue: firstNumValue,
          numericCell: firstNumCell,
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
    sheets[sheet.name] = {
      role,
      timeColumns: [...new Set(timeHeaders)],
      rowCount: maxRow || sheet.rowCount,
      colCount: maxCol,
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

    if (role === "assumptions" || role === "lookup" || role === "timeseries") {
      for (const pair of rowPairs.slice(0, 30)) {
        const id = toId(pair.label);
        if (!id) continue;
        inputCandidates.push({
          id,
          label: pair.label,
          sheet: sheet.name,
          cell: pair.numericCell,
          value: pair.numericValue,
        });
      }
    }
    if (role === "summary" || /p&l|profit|income|summary/i.test(sheet.name)) {
      for (const pair of rowPairs.slice(0, 20)) {
        const id = toId(pair.label);
        if (!id) continue;
        outputCandidates.push({
          id,
          label: pair.label,
          sheet: sheet.name,
          row: pair.row,
          cell: pair.numericCell,
          value: pair.numericValue,
        });
      }
    }

    if (!timeAxis && timeHeaders.length >= 2) {
      const aggregateCol = timeHeaders.find((h) => AGG_COL_REGEX.test(h));
      timeAxis = {
        sheet: sheet.name,
        columns: [...new Set(timeHeaders)],
        aggregateCol,
      };
    }
  });

  const denom = detectDenominationFromText(denomTextChunks.join("\n"));
  currency = denom.currency;
  unit = denom.unit || normalizeCurrencyUnit(denomTextChunks.join(" "));

  // Stamp per-cell source denomination, preferring per-sheet hints over document-global.
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

  // Canonicalize candidate numeric values into Million using per-sheet unit when available.
  const canonicalize = (value: number, sheetName: string): number => {
    const sheetMeta = sheets[sheetName];
    const sourceUnit =
      (sheetMeta?.unit as CurrencyUnit | undefined) ?? (unit as CurrencyUnit | undefined);
    const sourceCurrency = sheetMeta?.currency ?? currency;
    try {
      return toCanonical(value, { unit: sourceUnit, currency: sourceCurrency }).value;
    } catch {
      return value;
    }
  };
  for (const c of inputCandidates) {
    if (typeof c.value === "number" && Number.isFinite(c.value)) {
      c.value = canonicalize(c.value, c.sheet);
    }
  }
  for (const c of outputCandidates) {
    if (typeof c.value === "number" && Number.isFinite(c.value)) {
      c.value = canonicalize(c.value, c.sheet);
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
    ...(currency ? { currency } : {}),
    ...(unit ? { unit } : {}),
    ...(namedRanges.length > 0 ? { namedRanges } : {}),
    ...(largeWorkbook ? { largeWorkbook: true } : {}),
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
