/**
 * Data-quality analysis of an uploaded workbook.
 *
 * Structural ingestion already reports what the *file* does that the engine
 * cannot reproduce (macros, external links, volatile functions). This module
 * reports what the *data* does that a reader would not expect: a month fifty
 * times its neighbours, a cached #REF!, a gap in a series, a literal plugged
 * into a formula row, a schedule on the wrong year, an assumption wired to
 * nothing.
 *
 * These are findings, not fixes. Nothing here edits the workbook or substitutes
 * a value — the workbook stays the single source of truth. Each finding carries
 * enough detail for a human to decide whether the answer built on it can be
 * trusted, and a stable key so that decision survives re-ingestion.
 */

import type { PoolClient } from "pg";
import { pool } from "../db/index.js";
import { sha256 } from "../utils/hashChain.js";
import type { WorkbookGraph } from "./excelExtractor.js";
import { colIndexToLetters } from "./excelExtractor.js";
import type { SparseWorkbookSnapshot } from "./ingestionArtifacts.js";
import type { LeverBindingEvidence } from "./xlsxRuntime.js";

export type DataQualityCode =
  | "period_outlier"
  | "cached_formula_error"
  | "series_gap"
  | "hardcoded_plug"
  | "calendar_mismatch"
  | "inert_assumption";

export type DataQualitySeverity = "error" | "warning";

export interface DataQualityFinding {
  /** Stable across re-ingestion of unchanged data; changes when the data does. */
  findingKey: string;
  code: DataQualityCode;
  severity: DataQualitySeverity;
  title: string;
  /** Plain English, naming the cells, readable without opening the workbook. */
  message: string;
  sheet: string;
  cells: string[];
  rowLabel?: string;
  evidence?: Record<string, unknown>;
}

/** Excel error literals that survive into a cached formula result. */
const CACHED_ERROR_RE = /^#(REF|DIV\/0|VALUE|N\/A|NAME|NUM|NULL|SPILL|CALC)[!?]?/i;

/** A value this many times its row's median is not a normal period. */
const OUTLIER_FACTOR = 10;

/** Below this many points a "median" says nothing. */
const MIN_SERIES_LENGTH = 4;

/** A row this formula-dense with a literal in it is carrying a plug. */
const PLUG_FORMULA_RATIO = 0.7;

/** Cap per code so one pathological sheet cannot bury every other finding. */
const MAX_FINDINGS_PER_CODE = 25;

function findingKeyFor(
  code: DataQualityCode,
  sheet: string,
  cells: string[],
  values: unknown[],
): string {
  // Values participate in the key so that an unchanged workbook keeps its
  // acknowledgements, while a corrected — or newly broken — value produces a
  // different finding that has to be reviewed again.
  const rounded = values.map((v) =>
    typeof v === "number" && Number.isFinite(v) ? Math.round(v * 100) / 100 : String(v ?? ""),
  );
  return sha256(`${code}|${sheet}|${cells.join(",")}|${rounded.join(",")}`).slice(0, 32);
}

/**
 * Values that stand far off the median of their siblings.
 *
 * Median-based so the outlier cannot drag the threshold up around itself, which
 * is exactly what a mean would let it do. Shared with the run-time period check
 * so ingestion and simulation can never disagree about what counts as an outlier.
 */
export function medianOutliers(
  values: Array<{ label: string; value: number }>,
  factor = OUTLIER_FACTOR,
): { median: number; outliers: Array<{ label: string; value: number }> } | null {
  const finite = values.filter((v) => Number.isFinite(v.value));
  if (finite.length < MIN_SERIES_LENGTH) return null;

  const sorted = finite.map((v) => Math.abs(v.value)).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  if (!(median > 0)) return null;

  const outliers = finite.filter((v) => Math.abs(v.value) > median * factor);
  // More than half the row "outlying" means the median is the anomaly, not them.
  if (outliers.length === 0 || outliers.length > finite.length / 2) return null;
  return { median, outliers };
}

interface RowCell {
  col: number;
  address: string;
  value: number | null;
  isFormula: boolean;
  raw: string | number;
  cachedError?: string;
}

/** Group a sheet's sparse cells into rows, resolving formula cells to their cached result. */
function rowsOf(
  sheet: SparseWorkbookSnapshot["sheets"][string],
): Map<number, { label?: string; cells: RowCell[] }> {
  const rows = new Map<number, { label?: string; cells: RowCell[] }>();

  for (const cell of sheet.cells) {
    let entry = rows.get(cell.r);
    if (!entry) {
      entry = { cells: [] };
      rows.set(cell.r, entry);
    }

    const address = `${colIndexToLetters(cell.c)}${cell.r + 1}`;
    const isFormula = Boolean(cell.is_formula);
    const cachedError = cell.cached_error?.trim();

    if (cachedError && CACHED_ERROR_RE.test(cachedError)) {
      entry.cells.push({
        col: cell.c,
        address,
        value: null,
        isFormula,
        raw: cell.v as string | number,
        cachedError,
      });
      continue;
    }

    const cached = isFormula ? cell.expected : undefined;
    const numeric =
      typeof cached === "number" && Number.isFinite(cached)
        ? cached
        : !isFormula && typeof cell.v === "number" && Number.isFinite(cell.v)
          ? cell.v
          : null;

    if (numeric == null && typeof cell.v === "string" && !isFormula) {
      // Leftmost text on the row is its label.
      if (entry.label == null && cell.v.trim()) entry.label = cell.v.trim();
      continue;
    }

    entry.cells.push({
      col: cell.c,
      address,
      value: numeric,
      isFormula,
      raw: cell.v as string | number,
    });
  }

  return rows;
}

/** Four-digit year implied by a period header, when it states one at all. */
export function yearOfHeader(header: string): number | null {
  const fy = header.match(/\bfy[-\s]?(\d{2,4})\b/i);
  if (fy) {
    const n = Number(fy[1]);
    return n < 100 ? 2000 + n : n;
  }
  const suffixed = header.match(
    /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*[-\s']?(\d{2,4})\b/i,
  );
  if (suffixed) {
    const n = Number(suffixed[1]);
    return n < 100 ? 2000 + n : n;
  }
  const bare = header.match(/\b(19|20)\d{2}\b/);
  return bare ? Number(bare[0]) : null;
}

/** Dominant year across a set of period headers, or null when none state one. */
function axisYear(columns: string[]): number | null {
  const years = columns.map(yearOfHeader).filter((y): y is number => y != null);
  if (years.length === 0) return null;
  const counts = new Map<number, number>();
  for (const y of years) counts.set(y, (counts.get(y) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}


/** `Sheet!A1` in a single canonical spelling. */
function refKey(sheet: string, cell: string): string {
  return `${sheet.toLowerCase()}!${cell.replace(/\$/g, "").toUpperCase()}`;
}

const BARE_REF_RE = /(^|[^A-Za-z0-9_!:$])(\$?[A-Z]{1,3}\$?\d+)(?![\w(])/g;
const QUALIFIED_REF_RE = /(?:'([^']+)'|([A-Za-z0-9_ ]+))!(\$?[A-Z]{1,3}\$?\d+)/g;
const REF_RANGE_RE = /(?:(?:'([^']+)'|([A-Za-z0-9_ ]+))!)?\$?([A-Z]{1,3})\$?(\d+)\s*:\s*\$?([A-Z]{1,3})\$?(\d+)/g;

function lettersToCol(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

/**
 * Cells a formula reads, including same-sheet references.
 *
 * The persisted `dependencies` edges only carry cross-sheet refs, so a
 * within-sheet chain (`=D5+D9+D13`) looks like it reads nothing. Resolving both
 * here is what lets one corrupt input be recognised as the single cause of
 * every downstream total that quotes it.
 */
function readsOf(sheet: string, formula: string): string[] {
  const refs = new Set<string>();

  for (const m of formula.matchAll(REF_RANGE_RE)) {
    const target = (m[1] || m[2] || sheet).trim();
    const [c1, r1, c2, r2] = [lettersToCol(m[3]), Number(m[4]), lettersToCol(m[5]), Number(m[6])];
    const span = Math.abs(c2 - c1) + 1 + (Math.abs(r2 - r1) + 1);
    // Guard against a whole-sheet range blowing the walk up.
    if (span > 512) continue;
    for (let c = Math.min(c1, c2); c <= Math.max(c1, c2); c++) {
      for (let r = Math.min(r1, r2); r <= Math.max(r1, r2); r++) {
        refs.add(refKey(target, `${colIndexToLetters(c - 1)}${r}`));
      }
    }
  }

  const withoutRanges = formula.replace(REF_RANGE_RE, " ");
  for (const m of withoutRanges.matchAll(QUALIFIED_REF_RE)) {
    refs.add(refKey((m[1] || m[2]).trim(), m[3]));
  }
  const sameSheetOnly = withoutRanges.replace(QUALIFIED_REF_RE, " ");
  for (const m of sameSheetOnly.matchAll(BARE_REF_RE)) {
    refs.add(refKey(sheet, m[2]));
  }

  return [...refs];
}

/**
 * Drop findings that are downstream echoes of another finding.
 *
 * One bad input propagates: a corrupt volume cell reappears in the plan row
 * that grows it, the column total that sums it, the revenue line that prices
 * it, and every P&L row beneath. Reporting all of them buries the one cell a
 * human can actually act on. Only roots are kept; the echoes are counted on the
 * root so the blast radius is still visible.
 */
export function collapsePropagatedFindings(
  findings: DataQualityFinding[],
  formulaByRef: Map<string, { sheet: string; formula: string }>,
): DataQualityFinding[] {
  if (findings.length < 2) return findings;

  const ownerByRef = new Map<string, number>();
  findings.forEach((f, i) => {
    for (const cell of f.cells) ownerByRef.set(refKey(f.sheet, cell), i);
  });

  /** Finding indices reachable upstream from a cell, excluding the cell's own. */
  const ancestorsOf = (start: string, self: number): Set<number> => {
    const found = new Set<number>();
    const seen = new Set<string>([start]);
    let frontier = [start];
    for (let depth = 0; depth < 24 && frontier.length > 0; depth++) {
      const next: string[] = [];
      for (const ref of frontier) {
        const entry = formulaByRef.get(ref);
        if (!entry) continue;
        for (const read of readsOf(entry.sheet, entry.formula)) {
          if (seen.has(read)) continue;
          seen.add(read);
          const owner = ownerByRef.get(read);
          if (owner != null && owner !== self) found.add(owner);
          next.push(read);
        }
      }
      frontier = next.slice(0, 4096);
    }
    return found;
  };

  const ancestors = findings.map((f, i) => {
    const all = new Set<number>();
    for (const cell of f.cells) {
      for (const a of ancestorsOf(refKey(f.sheet, cell), i)) all.add(a);
    }
    return all;
  });

  const echoCount = new Map<number, number>();
  const kept: DataQualityFinding[] = [];
  findings.forEach((f, i) => {
    // A root has no flagged ancestor. Mutual reachability (a cycle) keeps both.
    const roots = [...ancestors[i]].filter((a) => !ancestors[a].has(i));
    if (roots.length === 0) {
      kept.push(f);
      return;
    }
    for (const r of roots) echoCount.set(r, (echoCount.get(r) ?? 0) + 1);
  });

  return kept.map((f) => {
    const idx = findings.indexOf(f);
    const echoes = echoCount.get(idx) ?? 0;
    if (echoes === 0) return f;
    return {
      ...f,
      message:
        `${f.message} This flows through to ${echoes} other calculated ` +
        `${echoes === 1 ? "line" : "lines"} in the workbook.`,
      evidence: { ...(f.evidence ?? {}), propagatesTo: echoes },
    };
  });
}

export function analyzeWorkbookDataQuality(
  graph: WorkbookGraph,
  snapshot: SparseWorkbookSnapshot | null,
): DataQualityFinding[] {
  const findings: DataQualityFinding[] = [];
  if (!snapshot) return findings;

  const formulaByRef = new Map<string, { sheet: string; formula: string }>();
  for (const sheetName of snapshot.sheetOrder) {
    const sheet = snapshot.sheets[sheetName];
    if (!sheet) continue;
    for (const cell of sheet.cells) {
      if (!cell.is_formula || typeof cell.v !== "string") continue;
      formulaByRef.set(refKey(sheetName, `${colIndexToLetters(cell.c)}${cell.r + 1}`), {
        sheet: sheetName,
        formula: cell.v,
      });
    }
  }

  const perCode = new Map<DataQualityCode, number>();
  const push = (f: DataQualityFinding) => {
    const seen = perCode.get(f.code) ?? 0;
    if (seen >= MAX_FINDINGS_PER_CODE) return;
    perCode.set(f.code, seen + 1);
    findings.push(f);
  };

  // Only sheets that hold identifiers rather than quantities are exempt.
  // "lookup" alone is too broad — a price list is classified lookup and its
  // numbers are exactly the kind worth checking.
  const referenceSheets = new Set(
    Object.entries(graph.sheets)
      .filter(([, meta]) => meta.referenceOnly || meta.role === "cover")
      .map(([name]) => name),
  );

  for (const sheetName of snapshot.sheetOrder) {
    const sheet = snapshot.sheets[sheetName];
    if (!sheet) continue;
    const isReference = referenceSheets.has(sheetName);
    const aggregateCol = graph.sheets[sheetName]?.aggregateColIndex;

    for (const [rowIdx, row] of rowsOf(sheet)) {
      // Header rows carry the period labels, not data.
      if (rowIdx < 1) continue;

      // ── cached_formula_error ── (checked even on reference sheets)
      for (const cell of row.cells) {
        if (!cell.cachedError) continue;
        push({
          findingKey: findingKeyFor("cached_formula_error", sheetName, [cell.address], [cell.cachedError]),
          code: "cached_formula_error",
          severity: "error",
          title: "Formula error in the source workbook",
          message:
            `${sheetName}!${cell.address}${row.label ? ` (${row.label})` : ""} evaluates to ` +
            `${cell.cachedError} in the workbook itself. Any total that includes this cell is unreliable.`,
          sheet: sheetName,
          cells: [cell.address],
          rowLabel: row.label,
          evidence: { error: cell.cachedError, formula: String(cell.raw).slice(0, 200) },
        });
      }

      if (isReference) continue;

      // Compare like with like. When the sheet has identified period columns,
      // the series is exactly those: a cost schedule routinely carries headcount
      // and an annual rate on the same row as twelve monthly amounts, and
      // treating the whole row as one series makes the headcount an "outlier".
      // The row's own total column is excluded either way — it is legitimately
      // an order of magnitude above every period in the row.
      const periodCols = graph.sheets[sheetName]?.periodColumnIndices;
      const inSeries = (col: number) =>
        (aggregateCol == null || col !== aggregateCol) &&
        (periodCols == null || periodCols.length === 0 || periodCols.includes(col));

      const band = row.cells
        .filter((c) => c.value != null && inSeries(c.col))
        .sort((a, b) => a.col - b.col);
      if (band.length < MIN_SERIES_LENGTH) continue;

      // ── period_outlier ──
      const outlierResult = medianOutliers(
        band.map((c) => ({ label: c.address, value: c.value as number })),
      );
      if (outlierResult) {
        const { median, outliers } = outlierResult;
        push({
          findingKey: findingKeyFor(
            "period_outlier",
            sheetName,
            outliers.map((o) => o.label),
            outliers.map((o) => o.value),
          ),
          code: "period_outlier",
          severity: "error",
          title: "A period is far out of line with the rest of its row",
          message:
            `${row.label ? `"${row.label}" on ` : ""}${sheetName}: ` +
            `${outliers
              .map((o) => `${o.label}=${o.value.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`)
              .join(", ")} against a median of ` +
            `${median.toLocaleString("en-IN", { maximumFractionDigits: 2 })} across ${band.length} periods. ` +
            `Anything that sums this row — including the annual total — carries the difference.`,
          sheet: sheetName,
          cells: outliers.map((o) => o.label),
          rowLabel: row.label,
          evidence: {
            median,
            periods: band.length,
            outliers: outliers.map((o) => ({ cell: o.label, value: o.value })),
          },
        });
      }

      // ── series_gap ── a hole inside an otherwise-populated run
      const firstCol = band[0].col;
      const lastCol = band[band.length - 1].col;
      const occupied = new Set(band.map((c) => c.col));
      const gaps: string[] = [];
      for (let c = firstCol + 1; c < lastCol; c++) {
        if (!occupied.has(c) && inSeries(c)) {
          gaps.push(`${colIndexToLetters(c)}${rowIdx + 1}`);
        }
      }
      if (gaps.length > 0) {
        push({
          findingKey: findingKeyFor("series_gap", sheetName, gaps, [band.length]),
          code: "series_gap",
          severity: "warning",
          title: "Gap inside a numeric series",
          message:
            `${row.label ? `"${row.label}" on ` : ""}${sheetName} is populated from ` +
            `${band[0].address} to ${band[band.length - 1].address} but ` +
            `${gaps.join(", ")} ${gaps.length === 1 ? "is" : "are"} empty. ` +
            `Sums treat the gap as zero, which understates the total.`,
          sheet: sheetName,
          cells: gaps,
          rowLabel: row.label,
          evidence: { populated: band.length, gaps: gaps.length },
        });
      }

      // ── hardcoded_plug ── a literal sitting in a calculated row
      const formulaCount = band.filter((c) => c.isFormula).length;
      const literals = band.filter((c) => !c.isFormula);
      if (
        formulaCount / band.length >= PLUG_FORMULA_RATIO &&
        literals.length > 0 &&
        literals.length < band.length
      ) {
        push({
          findingKey: findingKeyFor(
            "hardcoded_plug",
            sheetName,
            literals.map((c) => c.address),
            literals.map((c) => c.value),
          ),
          code: "hardcoded_plug",
          severity: "warning",
          title: "Hardcoded value inside a calculated row",
          message:
            `${row.label ? `"${row.label}" on ` : ""}${sheetName} is ${formulaCount} formulas and ` +
            `${literals.length} typed-in number(s) at ${literals.map((c) => c.address).join(", ")}. ` +
            `Those cells will not respond to any scenario change.`,
          sheet: sheetName,
          cells: literals.map((c) => c.address),
          rowLabel: row.label,
          evidence: {
            formulaCells: formulaCount,
            literals: literals.map((c) => ({ cell: c.address, value: c.value })),
          },
        });
      }
    }
  }

  // ── calendar_mismatch ──
  // Only when both axes state a year. A schedule headed "Apr … Mar" with no year
  // is not in conflict with anything — flagging it would be a false positive on
  // a perfectly consistent sheet.
  const chosenAxis = graph.timeAxis;
  const chosenYear = chosenAxis ? axisYear(chosenAxis.columns) : null;
  if (chosenAxis && chosenYear != null) {
    for (const candidate of graph.timeAxisCandidates ?? []) {
      if (candidate.sheet === chosenAxis.sheet) continue;
      const year = axisYear(candidate.columns);
      if (year == null || year === chosenYear) continue;
      push({
        findingKey: findingKeyFor("calendar_mismatch", candidate.sheet, [], [year, chosenYear]),
        code: "calendar_mismatch",
        severity: "warning",
        title: "A sheet is on a different year than the reported periods",
        message:
          `Results are reported on ${chosenAxis.sheet}'s ${chosenYear} calendar ` +
          `(${chosenAxis.columns[0]}…), but ${candidate.sheet} is on ${year} ` +
          `(${candidate.columns[0]}…). Confirm this is prior-year data feeding the plan ` +
          `rather than a period that should have been reported.`,
        sheet: candidate.sheet,
        cells: [],
        evidence: {
          reportedSheet: chosenAxis.sheet,
          reportedYear: chosenYear,
          otherSheet: candidate.sheet,
          otherYear: year,
        },
      });
    }
  }

  return collapsePropagatedFindings(findings, formulaByRef);
}

/**
 * Assumptions that drive nothing.
 *
 * Produced from the runtime's directional probe rather than the file, because
 * only evaluation can tell whether a cell reaches an output. An override on one
 * of these returns a successful run with an unchanged number, which reads as
 * "no material impact" rather than "this lever is not connected".
 */
export function inertAssumptionFindings(
  bindingEvidence: Record<string, LeverBindingEvidence> | undefined,
): DataQualityFinding[] {
  if (!bindingEvidence) return [];
  const findings: DataQualityFinding[] = [];

  for (const [id, ev] of Object.entries(bindingEvidence)) {
    if (ev.affectedOutputs.length > 0) continue;
    findings.push({
      findingKey: findingKeyFor("inert_assumption", ev.sheet, [ev.cell], [id, ev.base]),
      code: "inert_assumption",
      severity: "warning",
      title: "Assumption does not affect any reported metric",
      message:
        `"${ev.rowLabel || id}" (${ev.sheet}!${ev.cell}, currently ${ev.base}) changes no output ` +
        `metric when perturbed. Nothing on the P&L reads it, so a scenario built on it ` +
        `would report success without changing the result.`,
      sheet: ev.sheet,
      cells: [ev.cell],
      rowLabel: ev.rowLabel,
      evidence: { leverId: id, base: ev.base, labelMatchScore: ev.labelMatchScore },
    });
  }

  return findings;
}

// ── Persistence and decisions ──

export type DataQualityStatus = "open" | "acknowledged";

export interface StoredFinding extends DataQualityFinding {
  status: DataQualityStatus;
  note?: string | null;
  acknowledgedBy?: string | null;
  acknowledgedAt?: string | null;
}

interface FindingRow {
  finding_key: string;
  code: DataQualityCode;
  severity: DataQualitySeverity;
  title: string;
  message: string;
  sheet: string;
  cells: string[] | null;
  row_label: string | null;
  evidence: Record<string, unknown> | null;
  status: DataQualityStatus;
  note: string | null;
  acknowledged_by: string | null;
  acknowledged_at: string | null;
}

function toStored(row: FindingRow): StoredFinding {
  return {
    findingKey: row.finding_key,
    code: row.code,
    severity: row.severity,
    title: row.title,
    message: row.message,
    sheet: row.sheet,
    cells: row.cells ?? [],
    rowLabel: row.row_label ?? undefined,
    evidence: row.evidence ?? undefined,
    status: row.status,
    note: row.note,
    acknowledgedBy: row.acknowledged_by,
    acknowledgedAt: row.acknowledged_at,
  };
}

const SELECT_FINDING_COLUMNS = `finding_key, code, severity, title, message, sheet, cells,
   row_label, evidence, status, note, acknowledged_by, acknowledged_at`;

/**
 * Replace the finding set for a document, preserving decisions.
 *
 * A finding whose key is unchanged keeps its acknowledgement — re-processing a
 * workbook must not silently reopen questions somebody already answered. A key
 * that no longer appears is deleted, because the condition it described is gone.
 */
export async function persistFindings(
  documentId: string,
  workspaceId: string | null,
  findings: DataQualityFinding[],
  client?: PoolClient,
): Promise<{ inserted: number; retained: number; removed: number }> {
  const db = client ?? pool;
  const keys = findings.map((f) => f.findingKey);

  const removedRes = await db.query(
    `DELETE FROM data_quality_findings
     WHERE document_id = $1 AND NOT (finding_key = ANY($2::text[]))`,
    [documentId, keys],
  );

  let inserted = 0;
  let retained = 0;
  for (const f of findings) {
    const res = await db.query(
      `INSERT INTO data_quality_findings (
         document_id, workspace_id, finding_key, code, severity, title, message,
         sheet, cells, row_label, evidence
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (document_id, finding_key) DO UPDATE
         SET message = EXCLUDED.message,
             title = EXCLUDED.title,
             evidence = EXCLUDED.evidence,
             updated_at = NOW()
       RETURNING (xmax = 0) AS is_insert`,
      [
        documentId,
        workspaceId,
        f.findingKey,
        f.code,
        f.severity,
        f.title,
        f.message,
        f.sheet,
        f.cells,
        f.rowLabel ?? null,
        f.evidence ? JSON.stringify(f.evidence) : null,
      ],
    );
    if (res.rows[0]?.is_insert) inserted++;
    else retained++;
  }

  return { inserted, retained, removed: removedRes.rowCount ?? 0 };
}

export async function listFindings(documentId: string): Promise<StoredFinding[]> {
  const res = await pool.query<FindingRow>(
    `SELECT ${SELECT_FINDING_COLUMNS}
     FROM data_quality_findings
     WHERE document_id = $1
     ORDER BY (severity = 'error') DESC, (status = 'open') DESC, sheet, finding_key`,
    [documentId],
  );
  return res.rows.map(toStored);
}

/** Findings that must be decided before this model can be simulated. */
export async function listBlockingFindings(documentId: string): Promise<StoredFinding[]> {
  const res = await pool.query<FindingRow>(
    `SELECT ${SELECT_FINDING_COLUMNS}
     FROM data_quality_findings
     WHERE document_id = $1 AND status = 'open' AND severity = 'error'
     ORDER BY sheet, finding_key`,
    [documentId],
  );
  return res.rows.map(toStored);
}

export async function acknowledgeFinding(
  documentId: string,
  findingKey: string,
  userId: string,
  note: string,
): Promise<StoredFinding | null> {
  const res = await pool.query<FindingRow>(
    `UPDATE data_quality_findings
     SET status = 'acknowledged', note = $4, acknowledged_by = $3,
         acknowledged_at = NOW(), updated_at = NOW()
     WHERE document_id = $1 AND finding_key = $2
     RETURNING ${SELECT_FINDING_COLUMNS}`,
    [documentId, findingKey, userId, note],
  );
  return res.rows[0] ? toStored(res.rows[0]) : null;
}

/** Cells named by findings that are still open, for constraining lever mapping. */
export async function openFindingCells(
  documentId: string,
): Promise<Set<string>> {
  const res = await pool.query<{ sheet: string; cells: string[] | null }>(
    `SELECT sheet, cells FROM data_quality_findings
     WHERE document_id = $1 AND status = 'open' AND severity = 'error'`,
    [documentId],
  );
  const out = new Set<string>();
  for (const row of res.rows) {
    for (const cell of row.cells ?? []) out.add(refKey(row.sheet, cell));
  }
  return out;
}

/** Canonical `Sheet!A1` key, for matching a binding against finding cells. */
export function findingCellKey(sheet: string, cell: string): string {
  return refKey(sheet, cell);
}
