import ExcelJS from "exceljs";

export type SheetRole = "assumptions" | "timeseries" | "lookup" | "summary" | "cover";

export interface WorkbookSheetMeta {
  role: SheetRole;
  timeColumns: string[];
  rowCount: number;
  colCount: number;
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
  /**
   * Full cell grid per sheet (formulas as "=..." strings, values raw).
   * Consumed by XlsxModelRuntime to build a HyperFormula instance for
   * real cell-level simulation. Omitted for very large workbooks.
   */
  cellSnapshot?: Record<string, (string | number | null)[][]>;
}

/** Skip the snapshot above this cell count to bound memory/JSONB size. */
const CELL_SNAPSHOT_MAX_CELLS = 250_000;

const MONTH_REGEX = /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*[-\s']?\d{0,4}\b/i;
const QUARTER_REGEX = /\bq[1-4][-\s]?fy?\s?\d{0,4}\b/i;
const FY_REGEX = /\bfy[-\s]?\d{2,4}\b/i;
const AGG_COL_REGEX = /\b(total|fy|annual|year)\b/i;
const CROSS_SHEET_REF_REGEX = /(?:^|[^A-Za-z0-9_])([A-Za-z0-9_ ]+)![$]?[A-Z]{1,3}[$]?\d+/g;
const CELL_REF_REGEX = /(?:^|[^A-Za-z0-9_])([A-Za-z0-9_ ]+)!([$]?[A-Z]{1,3}[$]?\d+)/g;

/** Scale-suffix multipliers: "1.2M" -> 1.2 * 1e6, "500k" -> 500 * 1e3, etc. */
const SCALE_SUFFIXES: Record<string, number> = {
  k: 1e3,
  m: 1e6,
  mn: 1e6,
  mm: 1e6,
  bn: 1e9,
  b: 1e9,
  cr: 1e7, // crore
  l: 1e5,  // lakh
  lac: 1e5,
  lakh: 1e5,
};

export function parseNumericLike(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    let trimmed = value.trim();
    if (!trimmed) return null;

    // Accounting negatives: "(1,234)" or "$(1,234.56)" -> -1234.56
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

    // Strip currency symbols/codes and thousands separators, keep a
    // trailing scale suffix (k/M/mn/bn/Cr/L) for multiplier lookup.
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

function extractReadsFrom(formula: string): string[] {
  const refs: string[] = [];
  let match: RegExpExecArray | null = null;
  while ((match = CELL_REF_REGEX.exec(formula)) !== null) {
    const sheet = match[1].trim();
    const cell = match[2].replace(/\$/g, "");
    refs.push(`${sheet}!${cell}`);
  }
  return [...new Set(refs)];
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

export async function extractWorkbookGraph(buffer: Buffer): Promise<WorkbookGraph> {
  const workbook = new ExcelJS.Workbook();
  const arrayBuffer = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
  await workbook.xlsx.load(arrayBuffer);

  const sheets: Record<string, WorkbookSheetMeta> = {};
  const dependencies: WorkbookDependency[] = [];
  const inputCandidates: WorkbookGraph["inputCandidates"] = [];
  const outputCandidates: WorkbookGraph["outputCandidates"] = [];
  let scenarioToggle: { cell: string; values: string[] } | undefined;
  let timeAxis: WorkbookGraph["timeAxis"];
  let currency: string | undefined;
  let unit: string | undefined;

  const cellSnapshot: Record<string, (string | number | null)[][]> = {};
  let snapshotCellCount = 0;
  let snapshotTooLarge = false;

  workbook.eachSheet((sheet) => {
    const timeHeaders: string[] = [];
    let formulaCells = 0;
    let crossSheetFormulaCells = 0;
    let textCells = 0;
    let numericCells = 0;
    let maxCol = 0;
    const rowPairs: Array<{ row: number; label: string; numericValue: number; numericCell: string }> = [];
    const grid: (string | number | null)[][] = [];

    sheet.eachRow((row, rowNumber) => {
      maxCol = Math.max(maxCol, row.cellCount || 0);
      let firstText: string | null = null;
      let firstNumValue: number | null = null;
      let firstNumCell: string | null = null;
      row.eachCell((cell, colNumber) => {
        const raw = cell.value;

        // ── Cell snapshot for HyperFormula runtime ──
        if (!snapshotTooLarge) {
          const rowIdx = rowNumber - 1;
          const colIdx = colNumber - 1;
          while (grid.length <= rowIdx) grid.push([]);
          const gridRow = grid[rowIdx];
          while (gridRow.length <= colIdx) gridRow.push(null);
          if (cell.formula) {
            gridRow[colIdx] = normalizeFormula(cell.formula);
          } else if (typeof raw === "number" && Number.isFinite(raw)) {
            gridRow[colIdx] = raw;
          } else if (raw instanceof Date) {
            gridRow[colIdx] = raw.toISOString().slice(0, 10);
          } else if (raw != null) {
            const numeric = parseNumericLike(raw);
            gridRow[colIdx] = numeric != null ? numeric : String(raw);
          }
          snapshotCellCount++;
          if (snapshotCellCount > CELL_SNAPSHOT_MAX_CELLS) snapshotTooLarge = true;
        }

        const text = String(raw ?? "").trim();
        if (!text) return;

        if (rowNumber <= 3 && isTimeHeader(text)) {
          timeHeaders.push(text);
        }

        const numericLike = parseNumericLike(raw);
        if (numericLike != null) numericCells++;
        if (numericLike != null && firstNumValue == null) {
          firstNumValue = numericLike;
          firstNumCell = cell.address;
        }
        if (typeof raw === "string") {
          textCells++;
          if (!firstText) firstText = raw.trim();
          if (!currency && /\bINR\b|₹|\bUSD\b|\bEUR\b|\bGBP\b/i.test(raw)) {
            if (/INR|₹/i.test(raw)) currency = "INR";
            else if (/USD|\$/i.test(raw)) currency = "USD";
            else if (/EUR|€/i.test(raw)) currency = "EUR";
            else if (/GBP|£/i.test(raw)) currency = "GBP";
          }
          if (!unit && /\b(crore|cr|lakh|mn|million|bn|billion|thousand|k)\b/i.test(raw)) {
            if (/\bcrore|\bcr\b/i.test(raw)) unit = "Crore";
            else if (/\blakh/i.test(raw)) unit = "Lakh";
            else if (/\bmn|\bmillion/i.test(raw)) unit = "Million";
            else if (/\bbn|\bbillion/i.test(raw)) unit = "Billion";
            else unit = "Thousand";
          }
        }

        const formula = cell.formula;
        if (formula) {
          formulaCells++;
          const normalized = normalizeFormula(formula);
          const fromRef = `${sheet.name}!${cell.address}`;
          const readsFrom = extractReadsFrom(normalized);
          const isCross = CROSS_SHEET_REF_REGEX.test(normalized);
          CROSS_SHEET_REF_REGEX.lastIndex = 0;
          if (isCross) crossSheetFormulaCells++;
          dependencies.push({ from: fromRef, formula: normalized, readsFrom });

          if (!scenarioToggle && /IF\(/i.test(normalized)) {
            const labels = [...normalized.matchAll(/"(Base|Bull|Bear|Upside|Downside|Central|Aggressive|Conservative|S\d+)"/gi)]
              .map((m) => m[1]);
            const uniq = [...new Set(labels.map((v) => v.trim()))];
            if (uniq.length >= 2) {
              const selectorMatch = normalized.match(/IF\(([^=]+)=/i);
              const selectorCell = selectorMatch?.[1]?.replace(/\$/g, "").trim();
              scenarioToggle = {
                cell: selectorCell && /^[A-Z]{1,3}\d+$/i.test(selectorCell) ? `${sheet.name}!${selectorCell}` : fromRef,
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
      sheet.rowCount,
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
      rowCount: sheet.rowCount,
      colCount: maxCol,
    };

    if (role === "assumptions" || role === "lookup" || role === "timeseries") {
      for (const pair of rowPairs.slice(0, 30)) {
        const id = pair.label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
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
        const id = pair.label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
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

    cellSnapshot[sheet.name] = grid;
  });

  return {
    sheets,
    dependencies,
    ...(inputCandidates.length > 0 ? { inputCandidates } : {}),
    ...(outputCandidates.length > 0 ? { outputCandidates } : {}),
    ...(scenarioToggle ? { scenarioToggle } : {}),
    ...(timeAxis ? { timeAxis } : {}),
    ...(currency ? { currency } : {}),
    ...(unit ? { unit } : {}),
    ...(snapshotTooLarge ? {} : { cellSnapshot }),
  };
}
