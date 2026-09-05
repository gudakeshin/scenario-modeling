/**
 * XLSX Model Runtime — real cell-level simulation via HyperFormula.
 *
 * Hydrates from densified sparse workbook snapshots, binds levers/outputs by
 * explicit cell addresses (schema or candidates), and surfaces structured
 * build/binding/evaluation errors instead of silent null/zero fallbacks.
 */

import { HyperFormula, DetailedCellError } from "hyperformula";
import { config } from "../config.js";
import { LruCache } from "../utils/lruCache.js";
import {
  xlsxRuntimeCacheAccess,
  xlsxRuntimeCacheEntries,
  xlsxRuntimeProcessHeapBytes,
} from "../metrics.js";
import type { WorkbookGraph } from "./excelExtractor.js";
import type { EvaluableModel, ModelInput, PeriodSlice } from "./expression.js";
import {
  densifySnapshot,
  graphWithSnapshot,
  type SparseWorkbookSnapshot,
} from "./ingestionArtifacts.js";

interface CellAddress {
  sheetId: number;
  row: number;
  col: number;
}

interface LeverBinding extends CellAddress {
  id: string;
  label: string;
  base: number;
  sheet: string;
  /** The lever's own (Base) address — what the workbook calls this driver. */
  cell: string;
  /** The address actually written; equals `cell` unless the block has an Active twin. */
  writeCell: string;
  /** Pre-qualification ids this lever also answers to. */
  aliases?: string[];
  /**
   * True when {row,col} is the block's "Active" cell rather than its Base cell.
   * Scenario-variant blocks compute Active = IF(toggle="Bull", …), and every
   * downstream formula reads Active. Writing the Base cell only takes effect
   * while the toggle happens to sit on Base — otherwise the override silently
   * vanishes. Writing Active is correct under every toggle position.
   */
  writesActive: boolean;
}

interface OutputBinding extends CellAddress {
  id: string;
  label: string;
  sheet: string;
  cell: string;
  /**
   * The workbook's own period-total cell for this row. Read for the headline
   * P&L so the aggregate is the workbook's arithmetic rather than a re-sum of
   * evaluated periods (and never a single period masquerading as the year).
   */
  aggregate?: CellAddress & { cell: string };
}

export interface XlsxModelSchemaLike {
  scenarioLevers?: Array<{
    id: string;
    label?: string;
    sheet?: string;
    cell?: string;
    /** "Active" column twin driven by a scenario toggle. */
    activeCell?: string;
    /** Bare label id from before block qualification. */
    aliasId?: string;
    scenarios?: { base?: number };
  }>;
  outputMetrics?: Array<{
    id: string;
    label?: string;
    sheet?: string;
    row?: number;
    cell?: string;
    /** Workbook's own period-total cell for this row (e.g. P&L!O4). */
    aggregateCell?: string;
  }>;
  baseValues?: Record<string, number>;
}

export type RuntimeFailureReason =
  | "missing_snapshot"
  | "model_too_large"
  | "hyperformula_build"
  | "no_lever_bindings"
  | "no_output_bindings"
  | "duplicate_lever_ids"
  | "evaluation_error";

export interface RuntimeBuildResult {
  runtime: XlsxModelRuntime | null;
  ok: boolean;
  reason?: RuntimeFailureReason;
  errors: string[];
  warnings: string[];
  boundLevers: string[];
  boundOutputs: string[];
  unboundLevers: string[];
  unboundOutputs: string[];
  /** Per-lever directional probe + label-anchor check. */
  bindingEvidence?: Record<string, LeverBindingEvidence>;
}

export interface LeverBindingEvidence {
  sheet: string;
  cell: string;
  rowLabel: string;
  base: number;
  unit?: string;
  affectedOutputs: Array<{ id: string; label: string; direction: "up" | "down" | "flat"; delta: number }>;
  labelMatchScore: number;
  needsReview: boolean;
  reviewReason?: string;
}

/** Token Jaccard similarity for lever label vs extractor row label. */
export function labelSimilarity(a: string, b: string): number {
  const tok = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim()
        .split(/\s+/)
        .filter((t) => t.length > 1),
    );
  const A = tok(a);
  const B = tok(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

const LABEL_MATCH_THRESHOLD = 0.25;

/** Overrides probed individually for "moved nothing" before we stop. */
const MAX_INERT_PROBES = 25;

function toId(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

export function parseCellRef(ref: string): { row: number; col: number } | null {
  const m = ref.replace(/\$/g, "").match(/^([A-Z]{1,3})(\d+)$/i);
  if (!m) return null;
  let col = 0;
  const letters = m[1].toUpperCase();
  for (let i = 0; i < letters.length; i++) {
    col = col * 26 + (letters.charCodeAt(i) - 64);
  }
  return { row: parseInt(m[2], 10) - 1, col: col - 1 };
}

function isCellError(v: unknown): v is DetailedCellError {
  return v instanceof DetailedCellError ||
    (typeof v === "object" && v != null && "type" in (v as object) && "message" in (v as object));
}

function cellErrorMessage(v: DetailedCellError | { type?: string; message?: string }): string {
  return `${(v as DetailedCellError).type || "ERROR"}: ${(v as DetailedCellError).message || "cell error"}`;
}

/** Excel built-in defined names that HyperFormula rejects / are not useful. */
const XLNM_BUILTIN = /^_xlnm\./i;

export interface HfNamedExpression {
  name: string;
  expression: string;
  /** Sheet name for sheet-scoped names; omitted = workbook scope. */
  scope?: string;
}

/**
 * Transform ExcelJS defined-name `refersTo` into HyperFormula namedExpressions.
 * Skips multi-area refs, `_xlnm.*` builtins, and HF-rejected identifiers.
 */
export function toHyperFormulaNamedExpressions(
  namedRanges: Array<{ name: string; refersTo: string }> | undefined,
  sheetNames: string[],
): { expressions: HfNamedExpression[]; warnings: string[] } {
  const warnings: string[] = [];
  const expressions: HfNamedExpression[] = [];
  if (!namedRanges?.length) return { expressions, warnings };

  const sheetSet = new Set(sheetNames.map((s) => s.toLowerCase()));

  for (const nr of namedRanges) {
    const rawName = (nr.name || "").trim();
    if (!rawName) continue;
    if (XLNM_BUILTIN.test(rawName)) {
      warnings.push(`Skipped built-in named range '${rawName}'`);
      continue;
    }

    let scope: string | undefined;
    let name = rawName;
    // Sheet-scoped names often appear as "Sheet1!LocalName"
    const scopeMatch = rawName.match(/^(.+)!(.+)$/);
    if (scopeMatch && sheetSet.has(scopeMatch[1].replace(/^'|'$/g, "").toLowerCase())) {
      scope = scopeMatch[1].replace(/^'|'$/g, "");
      name = scopeMatch[2];
    }

    // HyperFormula identifiers: letter/underscore start, alnum/underscore/.
    if (!/^[A-Za-z_][A-Za-z0-9._]*$/.test(name)) {
      warnings.push(`Skipped named range '${rawName}': identifier not accepted by HyperFormula`);
      continue;
    }

    let refersTo = (nr.refersTo || "").trim();
    if (!refersTo || refersTo.toUpperCase().includes("#REF")) {
      warnings.push(`Skipped named range '${rawName}': empty or #REF! reference`);
      continue;
    }
    // Multi-area (comma-separated ranges outside of function args) — skip
    if (/,/.test(refersTo.replace(/"[^"]*"/g, ""))) {
      warnings.push(`Skipped named range '${rawName}': multi-area references are not supported`);
      continue;
    }

    if (!refersTo.startsWith("=")) refersTo = `=${refersTo}`;

    expressions.push(scope ? { name, expression: refersTo, scope } : { name, expression: refersTo });
  }

  return { expressions, warnings };
}

const FY_HEADER_RE = /\bfy[-\s]?\d{2,4}\b/i;
const MONTH_HEADER_RE = /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*[-\s']?\d{0,4}\b/i;
const QUARTER_HEADER_RE = /\bq[1-4](?:[-\s]?fy?\s?\d{0,4})?\b/i;

/**
 * Re-derive year_comparison for stale persisted graphs that lack `kind`.
 * FY-only axes (no month/quarter headers) are year comparisons, not forecast periods.
 */
function resolveTimeAxisKind(
  timeAxis: NonNullable<WorkbookGraph["timeAxis"]>,
): { kind: "periods" | "year_comparison"; primaryColumn?: string } {
  if (timeAxis.kind === "year_comparison" || timeAxis.kind === "periods") {
    return { kind: timeAxis.kind, primaryColumn: timeAxis.primaryColumn };
  }
  const cols = timeAxis.columns || [];
  const hasMonthOrQuarter = cols.some((h) => MONTH_HEADER_RE.test(h) || QUARTER_HEADER_RE.test(h));
  const fyCols = cols.filter((h) => FY_HEADER_RE.test(h));
  if (!hasMonthOrQuarter && fyCols.length >= 1) {
    return { kind: "year_comparison", primaryColumn: timeAxis.primaryColumn || fyCols[0] };
  }
  return { kind: "periods", primaryColumn: timeAxis.primaryColumn };
}

/**
 * Map time-axis header labels to 0-based column indices by scanning the first
 * few rows of the time-axis sheet in the densified snapshot.
 */
function resolvePeriodColumns(
  hf: HyperFormula,
  snapshot: Record<string, (string | number | null)[][]>,
  timeAxis: WorkbookGraph["timeAxis"] | null,
): PeriodColumn[] {
  if (!timeAxis || !timeAxis.columns || timeAxis.columns.length === 0) return [];

  const sheetId = hf.getSheetId(timeAxis.sheet);
  if (sheetId == null) return [];

  const grid = snapshot[timeAxis.sheet];
  if (!grid) return [];

  const headerToCol = new Map<string, number>();
  const scanRows = Math.min(3, grid.length);
  for (let r = 0; r < scanRows; r++) {
    const row = grid[r] || [];
    for (let c = 0; c < row.length; c++) {
      const cell = row[c];
      if (cell == null) continue;
      const text = String(cell).trim();
      if (!text) continue;
      if (timeAxis.columns.includes(text) && !headerToCol.has(text)) {
        headerToCol.set(text, c);
      }
    }
  }

  const { kind, primaryColumn } = resolveTimeAxisKind(timeAxis);

  // Year-comparison (FY25 vs FY24): only the primary/current column is a period.
  // ≤1 column ⇒ supportsPeriods false ⇒ no cross-year aggregation.
  if (kind === "year_comparison") {
    const primary = primaryColumn || timeAxis.columns[0];
    const col = headerToCol.get(primary);
    if (col != null) return [{ period: primary, col }];
    for (const period of timeAxis.columns) {
      const c = headerToCol.get(period);
      if (c != null) return [{ period, col: c }];
    }
    return [];
  }

  const periods: PeriodColumn[] = [];
  for (const period of timeAxis.columns) {
    if (timeAxis.aggregateCol && period === timeAxis.aggregateCol) continue;
    const col = headerToCol.get(period);
    if (col != null) periods.push({ period, col });
  }
  return periods;
}

interface PeriodColumn {
  period: string;
  col: number;
}

export class XlsxModelRuntime implements EvaluableModel {
  readonly kind = "xlsx" as const;
  readonly inputs: ModelInput[];
  readonly outputIds: string[];
  readonly supportsPeriods: boolean;
  readonly lastEvaluationErrors: string[] = [];
  /** Override ids that did not match a bound lever on the last evaluate(). */
  readonly lastIgnoredOverrides: string[] = [];

  private hf: HyperFormula;
  private levers: Map<string, LeverBinding>;
  /**
   * Bare pre-qualification ids → lever id, for ids that map to exactly one
   * lever. Scenarios saved before block qualification store the bare label
   * ("material_cost_of_nsp"), and those should still resolve. Ambiguous ones
   * ("bullet", claimed by both the volume and price blocks) are deliberately
   * absent: guessing between two cells is how the original bug behaved.
   */
  private leverAliases: Map<string, string>;
  private outputs: OutputBinding[];
  private timeAxis: WorkbookGraph["timeAxis"] | null;
  private periodColumns: PeriodColumn[];

  private constructor(
    hf: HyperFormula,
    levers: LeverBinding[],
    outputs: OutputBinding[],
    timeAxis: WorkbookGraph["timeAxis"] | null,
    periodColumns: PeriodColumn[],
  ) {
    this.hf = hf;
    this.levers = new Map(levers.map((l) => [l.id, l]));

    const aliasCounts = new Map<string, string[]>();
    for (const lever of levers) {
      for (const alias of lever.aliases ?? []) {
        const key = toId(alias);
        if (!key || this.levers.has(key)) continue;
        const seen = aliasCounts.get(key);
        if (seen) seen.push(lever.id);
        else aliasCounts.set(key, [lever.id]);
      }
    }
    this.leverAliases = new Map(
      [...aliasCounts.entries()]
        .filter(([, ids]) => new Set(ids).size === 1)
        .map(([alias, ids]) => [alias, ids[0]] as const),
    );
    this.outputs = outputs;
    this.timeAxis = timeAxis;
    this.periodColumns = periodColumns;
    this.supportsPeriods = periodColumns.length > 1;
    // Deduplicate lever ids (schema can list the same id more than once)
    const seen = new Set<string>();
    this.inputs = [];
    for (const l of levers) {
      if (seen.has(l.id)) continue;
      seen.add(l.id);
      this.inputs.push({ id: l.id, name: l.label, base: l.base });
    }
    this.outputIds = outputs.map((o) => o.id);
  }

  static build(
    graph: WorkbookGraph,
    schema: XlsxModelSchemaLike,
    sparseSnapshot?: SparseWorkbookSnapshot | null,
  ): RuntimeBuildResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    let working = graph;
    if (sparseSnapshot) {
      const estimatedCells = Object.values(sparseSnapshot.sheets).reduce(
        (sum, sheet) => sum + sheet.rows * sheet.cols,
        0,
      );
      if (estimatedCells > config.XLSX_RUNTIME_MAX_CELLS) {
        return {
          runtime: null,
          ok: false,
          reason: "model_too_large",
          errors: [
            `Model grid is too large for the interactive engine (${estimatedCells.toLocaleString("en-IN")} estimated cells; limit ${config.XLSX_RUNTIME_MAX_CELLS.toLocaleString("en-IN")}).`,
          ],
          warnings,
          boundLevers: [],
          boundOutputs: [],
          unboundLevers: (schema.scenarioLevers || []).map((lever) => toId(lever.id)),
          unboundOutputs: (schema.outputMetrics || []).map((metric) => toId(metric.id)),
        };
      }
      working = graphWithSnapshot(graph, sparseSnapshot);
    } else if (!graph.cellSnapshot || Object.keys(graph.cellSnapshot).length === 0) {
      return {
        runtime: null,
        ok: false,
        reason: "missing_snapshot",
        errors: [
          "No cell snapshot available. Re-upload the XLSX or run reprocess-workbooks.ts so formulas are preserved.",
        ],
        warnings,
        boundLevers: [],
        boundOutputs: [],
        unboundLevers: (schema.scenarioLevers || []).map((l) => toId(l.id)),
        unboundOutputs: (schema.outputMetrics || []).map((m) => toId(m.id)),
      };
    }

    const snapshot = working.cellSnapshot!;
    const sheetNames = Object.keys(snapshot);
    const { expressions: namedExprs, warnings: namedWarnings } = toHyperFormulaNamedExpressions(
      working.namedRanges,
      sheetNames,
    );
    warnings.push(...namedWarnings);

    let hf: HyperFormula;
    try {
      hf = HyperFormula.buildFromSheets(snapshot as Record<string, (string | number | null)[][]>, {
        licenseKey: config.HYPERFORMULA_LICENSE_KEY,
        useColumnIndex: false,
      });
    } catch (e) {
      return {
        runtime: null,
        ok: false,
        reason: "hyperformula_build",
        errors: [`HyperFormula failed to build workbook: ${(e as Error).message}`],
        warnings,
        boundLevers: [],
        boundOutputs: [],
        unboundLevers: (schema.scenarioLevers || []).map((l) => toId(l.id)),
        unboundOutputs: (schema.outputMetrics || []).map((m) => toId(m.id)),
      };
    }

    const sheetIdByName = new Map<string, number>();
    for (const name of sheetNames) {
      const id = hf.getSheetId(name);
      if (id != null) sheetIdByName.set(name, id);
    }

    for (const e of namedExprs) {
      try {
        if (e.scope) {
          const sid = sheetIdByName.get(e.scope);
          if (sid == null) {
            warnings.push(`Skipped sheet-scoped name '${e.name}': sheet '${e.scope}' not found`);
            continue;
          }
          hf.addNamedExpression(e.name, e.expression, sid);
        } else {
          hf.addNamedExpression(e.name, e.expression);
        }
      } catch (err) {
        warnings.push(
          `Skipped named range '${e.name}': HyperFormula rejected it (${(err as Error).message})`,
        );
      }
    }

    // Index by both the current (block-qualified) id and the bare alias, so a
    // model_schema persisted before block qualification still resolves.
    const indexCandidates = <T extends { id?: string; label?: string; aliasId?: string }>(
      list: T[] | undefined,
    ): Map<string, T> => {
      const map = new Map<string, T>();
      for (const c of list || []) {
        const primary = toId(c.id || c.label || "");
        if (primary) map.set(primary, c);
      }
      for (const c of list || []) {
        const alias = c.aliasId ? toId(c.aliasId) : "";
        if (alias && !map.has(alias)) map.set(alias, c);
      }
      return map;
    };
    const candidateById = indexCandidates(graph.inputCandidates);
    const outputCandidateById = indexCandidates(graph.outputCandidates);

    const levers: LeverBinding[] = [];
    const unboundLevers: string[] = [];
    const duplicateLeverIds: string[] = [];
    for (const lever of schema.scenarioLevers || []) {
      const id = toId(lever.id);
      const cand = candidateById.get(id);
      const sheet = lever.sheet || cand?.sheet;
      const cell = lever.cell || cand?.cell;
      if (!sheet || !cell) {
        unboundLevers.push(id);
        continue;
      }
      const sheetId = sheetIdByName.get(sheet);
      const pos = parseCellRef(cell);
      if (sheetId == null || !pos) {
        unboundLevers.push(id);
        errors.push(`Lever '${id}' cell ${sheet}!${cell} could not be resolved`);
        continue;
      }
      // Bind the Active cell when the block has one, so overrides apply under
      // every scenario-toggle position rather than only on the Base branch.
      const activeRef = lever.activeCell || cand?.activeCell;
      const activePos = activeRef ? parseCellRef(activeRef) : null;
      const writesActive = Boolean(activePos);
      const targetPos = activePos ?? pos;
      const targetCell = activePos ? activeRef! : cell;

      // Prefer the live cell value so percent-override math stays unit-consistent
      // even when persisted model_schema still carries ×10 canonicalized bases.
      const cellVal = hf.getCellValue({ sheet: sheetId, row: targetPos.row, col: targetPos.col });
      const baseFromCell =
        typeof cellVal === "number" && Number.isFinite(cellVal) ? cellVal : null;
      const binding: LeverBinding = {
        id,
        label: lever.label || lever.id,
        base: baseFromCell ?? Number(lever.scenarios?.base ?? cand?.value ?? 0),
        sheetId,
        row: targetPos.row,
        col: targetPos.col,
        sheet,
        cell,
        writeCell: targetCell,
        writesActive,
        aliases: [lever.aliasId, cand?.aliasId].filter(
          (a): a is string => Boolean(a) && toId(a!) !== id,
        ),
      };

      // A duplicate id means two different cells claim the same lever. Silently
      // keeping the last one binds a cell whose base differs from the one the
      // caller sees, turning "+7.5%" into an arbitrary multiple. Refuse instead.
      const clash = levers.find((l) => l.id === id);
      if (clash) {
        if (clash.sheet === binding.sheet && clash.cell === binding.cell) continue;
        duplicateLeverIds.push(id);
        errors.push(
          `Lever id '${id}' is claimed by two cells (${clash.sheet}!${clash.cell} base ${clash.base}, ` +
            `${binding.sheet}!${binding.cell} base ${binding.base}). ` +
            `Re-ingest the workbook so block-qualified ids are assigned.`,
        );
        continue;
      }
      levers.push(binding);
    }

    const outputs: OutputBinding[] = [];
    const unboundOutputs: string[] = [];
    for (const metric of schema.outputMetrics || []) {
      const id = toId(metric.id);
      // Outputs that only appear as input candidates (e.g. revenue_cr on Assumptions)
      // must still bind — otherwise base_pl drops them as zeros.
      const cand = outputCandidateById.get(id) ?? candidateById.get(id);
      const sheet = metric.sheet || cand?.sheet;
      let cell = metric.cell || cand?.cell;
      // Fallback: sheet + row → first numeric candidate cell on that row
      if (!cell && sheet && metric.row) {
        const match = (graph.outputCandidates || []).find(
          (c) => c.sheet === sheet && c.row === metric.row && c.cell,
        );
        cell = match?.cell;
      }
      if (!sheet || !cell) {
        unboundOutputs.push(id);
        continue;
      }
      const sheetId = sheetIdByName.get(sheet);
      const pos = parseCellRef(cell);
      if (sheetId == null || !pos) {
        unboundOutputs.push(id);
        errors.push(`Output '${id}' cell ${sheet}!${cell} could not be resolved`);
        continue;
      }
      const aggregateRef = metric.aggregateCell || (cand && "aggregateCell" in cand ? cand.aggregateCell : undefined);
      const aggregatePos = aggregateRef ? parseCellRef(aggregateRef) : null;
      outputs.push({
        id,
        label: metric.label || metric.id,
        sheetId,
        row: pos.row,
        col: pos.col,
        sheet,
        cell,
        ...(aggregatePos && aggregateRef
          ? {
              aggregate: {
                sheetId,
                row: aggregatePos.row,
                col: aggregatePos.col,
                cell: aggregateRef,
              },
            }
          : {}),
      });
    }

    // A duplicate id means overrides would write a cell whose base differs from
    // the one reported to the caller. Returning a usable runtime here left the
    // problem visible only to the validation endpoint, so a workbook already
    // marked ready kept simulating with a lever silently dropped.
    if (duplicateLeverIds.length > 0) {
      return {
        runtime: null,
        ok: false,
        reason: "duplicate_lever_ids",
        errors,
        warnings,
        boundLevers: levers.map((l) => l.id),
        boundOutputs: outputs.map((o) => o.id),
        unboundLevers,
        unboundOutputs,
      };
    }

    if (levers.length === 0) {
      return {
        runtime: null,
        ok: false,
        reason: "no_lever_bindings",
        errors: [...errors, "No scenario levers could be bound to workbook cells"],
        warnings,
        boundLevers: [],
        boundOutputs: outputs.map((o) => o.id),
        unboundLevers,
        unboundOutputs,
      };
    }
    if (outputs.length === 0) {
      return {
        runtime: null,
        ok: false,
        reason: "no_output_bindings",
        errors: [...errors, "No output metrics could be bound to workbook cells"],
        warnings,
        boundLevers: levers.map((l) => l.id),
        boundOutputs: [],
        unboundLevers,
        unboundOutputs,
      };
    }

    if (unboundLevers.length > 0) {
      warnings.push(`Unbound levers: ${unboundLevers.join(", ")}`);
    }
    if (unboundOutputs.length > 0) {
      warnings.push(`Unbound outputs: ${unboundOutputs.join(", ")}`);
    }

    // Baseline evaluation sanity check
    const periodColumns = resolvePeriodColumns(hf, snapshot, working.timeAxis ?? null);
    const runtime = new XlsxModelRuntime(hf, levers, outputs, working.timeAxis ?? null, periodColumns);
    const baseline = runtime.evaluate({});
    if (runtime.lastEvaluationErrors.length > 0) {
      warnings.push(...runtime.lastEvaluationErrors);
    }

    const labelById = new Map<string, string>();
    for (const c of graph.inputCandidates || []) {
      labelById.set(toId(c.id || c.label || ""), c.label);
    }
    const bindingEvidence = runtime.probeBindings(labelById);
    for (const [id, ev] of Object.entries(bindingEvidence)) {
      if (ev.needsReview) {
        warnings.push(
          `Lever '${id}' needs review: ${ev.reviewReason || "binding evidence weak"} ` +
            `(${ev.sheet}!${ev.cell}, label="${ev.rowLabel}")`,
        );
      }
    }
    void baseline;

    return {
      runtime,
      ok: true,
      errors,
      warnings,
      boundLevers: levers.map((l) => l.id),
      boundOutputs: outputs.map((o) => o.id),
      unboundLevers,
      unboundOutputs,
      bindingEvidence,
    };
  }

  /** Backward-compatible helper — returns runtime or null. */
  static fromWorkbook(
    graph: WorkbookGraph,
    schema: XlsxModelSchemaLike,
    sparseSnapshot?: SparseWorkbookSnapshot | null,
  ): XlsxModelRuntime | null {
    return XlsxModelRuntime.build(graph, schema, sparseSnapshot).runtime;
  }

  /** Expose stored time axis for diagnostics / multi-period consumers. */
  get timeAxisRef(): WorkbookGraph["timeAxis"] | null {
    return this.timeAxis;
  }

  /**
   * Outputs that belong on a reported P&L.
   *
   * `outputIds` also carries derived rows harvested from working schedules — a
   * unit count like `fy23_total` on a volume sheet. Running plausibility checks
   * over those produces findings about quantities that were never part of the
   * financial statement, which reads as noise next to the real ones.
   */
  get reportableOutputIds(): string[] {
    const axisSheet = this.timeAxis?.sheet;
    if (!axisSheet) return this.outputIds;
    const onAxisSheet = this.outputs.filter((o) => o.sheet === axisSheet).map((o) => o.id);
    return onAxisSheet.length > 0 ? onAxisSheet : this.outputIds;
  }

  /**
   * Outputs whose annual figure comes from the workbook's own total column.
   * Callers must not re-sum these from evaluated periods — that would replace
   * the workbook's arithmetic with their own and double-count any total column
   * still present in the period set.
   */
  get outputsWithWorkbookTotal(): Set<string> {
    return new Set(this.outputs.filter((o) => o.aggregate).map((o) => o.id));
  }

  /**
   * Directional probe: perturb each lever +1%, record which outputs move.
   * Label-anchor: fuzzy-match lever label vs extractor row label.
   */
  probeBindings(rowLabelByLeverId?: Map<string, string>): Record<string, LeverBindingEvidence> {
    const evidence: Record<string, LeverBindingEvidence> = {};
    const baseOut = this.evaluate({});

    for (const lever of this.levers.values()) {
      const rowLabel = rowLabelByLeverId?.get(lever.id) || lever.label;
      const probeVal = lever.base * 1.01;
      const probed = this.evaluate({ [lever.id]: probeVal });
      const affectedOutputs: LeverBindingEvidence["affectedOutputs"] = [];

      for (const out of this.outputs) {
        const b = baseOut[out.id];
        const p = probed[out.id];
        if (!Number.isFinite(b) || !Number.isFinite(p)) continue;
        const delta = p - b;
        const eps = Math.max(1e-9, Math.abs(b) * 1e-9);
        const direction: "up" | "down" | "flat" =
          Math.abs(delta) <= eps ? "flat" : delta > 0 ? "up" : "down";
        if (direction !== "flat") {
          affectedOutputs.push({ id: out.id, label: out.label, direction, delta });
        }
      }

      const labelMatchScore = labelSimilarity(lever.label, rowLabel);
      let needsReview = false;
      let reviewReason: string | undefined;

      if (affectedOutputs.length === 0) {
        needsReview = true;
        reviewReason = "perturbation moved no outputs";
      } else if (
        /cost|fuel|expense|opex|cogs/i.test(lever.label) &&
        affectedOutputs.every((o) => /revenue|sales|top.?line/i.test(o.id + o.label)) &&
        !affectedOutputs.some((o) => /cost|ebitda|margin|profit|income|cogs|opex/i.test(o.id + o.label))
      ) {
        needsReview = true;
        reviewReason = "cost-like lever only moved revenue-like outputs";
      } else if (labelMatchScore < LABEL_MATCH_THRESHOLD && lever.label !== rowLabel) {
        needsReview = true;
        reviewReason = `label mismatch (score ${labelMatchScore.toFixed(2)})`;
      }

      evidence[lever.id] = {
        sheet: lever.sheet,
        cell: lever.cell,
        rowLabel,
        base: lever.base,
        affectedOutputs,
        labelMatchScore,
        needsReview,
        ...(reviewReason ? { reviewReason } : {}),
      };
    }

    return evidence;
  }

  /**
   * Overrides that bind a real lever but move nothing.
   *
   * An override matching no lever id is already reported via
   * lastIgnoredOverrides. The quieter failure is an override that binds
   * cleanly to a cell no output depends on: the run succeeds, the number is
   * unchanged, and the report implies the lever was applied. Each override is
   * evaluated on its own so the finding is per-lever rather than "nothing moved".
   */
  findInertOverrides(absoluteOverrides: Record<string, number>): Array<{
    id: string;
    sheet: string;
    cell: string;
  }> {
    // One full recalculation per override. Bounded so a wide scenario on a large
    // workbook cannot spend the whole simulation budget here; beyond the cap the
    // persisted probe evidence already answers the same question.
    const candidates = Object.entries(absoluteOverrides).slice(0, MAX_INERT_PROBES);
    const baseline = this.evaluate({});
    const inert: Array<{ id: string; sheet: string; cell: string }> = [];

    for (const [id, value] of candidates) {
      const binding = this.resolveLever(id);
      if (!binding || !Number.isFinite(value)) continue;
      if (value === binding.base) continue; // not a change, so not a finding
      const probed = this.evaluate({ [id]: value });
      const moved = this.outputs.some((out) => {
        const before = baseline[out.id];
        const after = probed[out.id];
        if (!Number.isFinite(before) || !Number.isFinite(after)) return false;
        return Math.abs(after - before) > Math.max(1e-9, Math.abs(before) * 1e-9);
      });
      if (!moved) inert.push({ id, sheet: binding.sheet, cell: binding.cell });
    }

    return inert;
  }

  /**
   * Canonical lever id for an override id, or undefined when it matches nothing.
   * Exposed so override resolution reads bases from the same lever the write
   * will land on.
   */
  resolveInputId(id: string): string | undefined {
    return this.resolveLever(id)?.id;
  }

  /** Resolve an override id to a lever, falling back to unambiguous aliases. */
  private resolveLever(id: string): LeverBinding | undefined {
    const key = toId(id);
    const direct = this.levers.get(key);
    if (direct) return direct;
    const aliased = this.leverAliases.get(key);
    return aliased ? this.levers.get(aliased) : undefined;
  }

  evaluate(absoluteOverrides: Record<string, number>): Record<string, number> {
    this.lastEvaluationErrors.length = 0;
    this.lastIgnoredOverrides.length = 0;
    // Restore via getCellSerialized (formula text or raw value). getCellValue would
    // bake computed numbers back into formula cells and permanently break the DAG —
    // especially when probeBindings temporarily writes every lever.
    const touched: Array<{ binding: LeverBinding; previous: string | number | boolean | null }> = [];

    try {
      for (const [id, value] of Object.entries(absoluteOverrides)) {
        const binding = this.resolveLever(id);
        if (!binding || !Number.isFinite(value)) {
          if (Number.isFinite(value)) this.lastIgnoredOverrides.push(id);
          continue;
        }
        const addr = { sheet: binding.sheetId, row: binding.row, col: binding.col };
        const previous = this.hf.getCellSerialized(addr);
        this.hf.setCellContents(addr, [[value]]);
        touched.push({ binding, previous: previous as string | number | boolean | null });
      }

      const result: Record<string, number> = {};
      for (const lever of this.levers.values()) {
        const v = this.hf.getCellValue({ sheet: lever.sheetId, row: lever.row, col: lever.col });
        if (isCellError(v)) {
          this.lastEvaluationErrors.push(`Lever ${lever.id} (${lever.sheet}!${lever.cell}): ${cellErrorMessage(v)}`);
          result[lever.id] = lever.base;
        } else {
          result[lever.id] = typeof v === "number" && Number.isFinite(v) ? v : lever.base;
        }
      }
      for (const out of this.outputs) {
        // Read the workbook's own period-total when it has one. Without this the
        // headline P&L is whichever single column the row was bound to — on a
        // monthly model that is April presented as the full year.
        const addr = out.aggregate ?? out;
        const label = out.aggregate ? out.aggregate.cell : out.cell;
        const v = this.hf.getCellValue({ sheet: addr.sheetId, row: addr.row, col: addr.col });
        if (isCellError(v)) {
          this.lastEvaluationErrors.push(`Output ${out.id} (${out.sheet}!${label}): ${cellErrorMessage(v)}`);
          // Do not silently invent 0 — use NaN marker converted to nullish handling upstream;
          // keep numeric contract with NaN filtered by callers via Number.isFinite checks.
          result[out.id] = Number.NaN;
        } else if (typeof v === "number" && Number.isFinite(v)) {
          result[out.id] = v;
        } else {
          this.lastEvaluationErrors.push(
            `Output ${out.id} (${out.sheet}!${label}) is non-numeric: ${String(v)}`,
          );
          result[out.id] = Number.NaN;
        }
      }
      return result;
    } finally {
      for (const { binding, previous } of touched.reverse()) {
        this.hf.setCellContents(
          { sheet: binding.sheetId, row: binding.row, col: binding.col },
          [[previous as number | string | null]],
        );
      }
    }
  }

  /**
   * Evaluate outputs for each time-axis period column when available.
   * Lever cells are set once; outputs are read from the same row at each period col.
   * Falls back to a single FY slice from evaluate() when no time axis is present.
   *
   * A single detected period column is also routed through evaluate() rather
   * than the column-substitution path below: with one period there is nothing
   * to slice, and reading every output at that one global column index — instead
   * of the output's own bound column — silently misreads any output whose sheet
   * orders its columns differently. On a Cipla P&L (FY25 at column C) alongside
   * a Cost_Build sheet (FY25 at column B, FY24 at column C), this pulled the
   * prior-year Cost_Build revenue while correctly reading the current-year P&L
   * revenue, producing two "revenue" figures that silently disagreed.
   */
  evaluatePeriods(absoluteOverrides: Record<string, number>): PeriodSlice[] {
    if (this.periodColumns.length <= 1) {
      const period = this.periodColumns[0]?.period ?? "FY";
      return [{ period, values: this.evaluate(absoluteOverrides) }];
    }

    this.lastEvaluationErrors.length = 0;
    // Restore via getCellSerialized (formula text or raw value), matching
    // evaluate(). getCellValue returns the *computed* number, so restoring with
    // it bakes a constant into any formula-backed lever cell and permanently
    // breaks the DAG for every later run served from the cached runtime.
    const touched: Array<{ binding: LeverBinding; previous: string | number | boolean | null }> = [];

    try {
      for (const [id, value] of Object.entries(absoluteOverrides)) {
        const binding = this.resolveLever(id);
        if (!binding || !Number.isFinite(value)) continue;
        const previous = this.hf.getCellSerialized({
          sheet: binding.sheetId,
          row: binding.row,
          col: binding.col,
        });
        this.hf.setCellContents(
          { sheet: binding.sheetId, row: binding.row, col: binding.col },
          [[value]],
        );
        touched.push({ binding, previous: previous as string | number | boolean | null });
      }

      const leverValues: Record<string, number> = {};
      for (const lever of this.levers.values()) {
        const v = this.hf.getCellValue({ sheet: lever.sheetId, row: lever.row, col: lever.col });
        if (isCellError(v)) {
          this.lastEvaluationErrors.push(`Lever ${lever.id} (${lever.sheet}!${lever.cell}): ${cellErrorMessage(v)}`);
          leverValues[lever.id] = lever.base;
        } else {
          leverValues[lever.id] = typeof v === "number" && Number.isFinite(v) ? v : lever.base;
        }
      }

      return this.periodColumns.map(({ period, col }) => {
        const values: Record<string, number> = { ...leverValues };
        for (const out of this.outputs) {
          const v = this.hf.getCellValue({ sheet: out.sheetId, row: out.row, col });
          if (isCellError(v)) {
            this.lastEvaluationErrors.push(
              `Output ${out.id} period ${period} (${out.sheet} row ${out.row + 1}): ${cellErrorMessage(v)}`,
            );
            values[out.id] = Number.NaN;
          } else if (typeof v === "number" && Number.isFinite(v)) {
            values[out.id] = v;
          } else {
            this.lastEvaluationErrors.push(
              `Output ${out.id} period ${period} is non-numeric: ${String(v)}`,
            );
            values[out.id] = Number.NaN;
          }
        }
        return { period, values };
      });
    } finally {
      for (const { binding, previous } of touched.reverse()) {
        this.hf.setCellContents(
          { sheet: binding.sheetId, row: binding.row, col: binding.col },
          [[previous as number | string | null]],
        );
      }
    }
  }
}

const runtimeCache = new LruCache<string, XlsxModelRuntime | null>({
  maxEntries: config.XLSX_RUNTIME_CACHE_MAX_ENTRIES,
  ttlMs: config.XLSX_RUNTIME_CACHE_TTL_MS,
});

function cacheRuntime(key: string, runtime: XlsxModelRuntime | null): void {
  runtimeCache.set(key, runtime);
  xlsxRuntimeCacheEntries.set(runtimeCache.size);
  xlsxRuntimeProcessHeapBytes.set(process.memoryUsage().heapUsed);
}

export function getXlsxRuntime(
  cacheKey: string,
  graph: WorkbookGraph,
  schema: XlsxModelSchemaLike,
  sparseSnapshot?: SparseWorkbookSnapshot | null,
): XlsxModelRuntime | null {
  const cached = runtimeCache.get(cacheKey);
  if (cached !== undefined) {
    xlsxRuntimeCacheAccess.inc({ result: "hit" });
    xlsxRuntimeCacheEntries.set(runtimeCache.size);
    xlsxRuntimeProcessHeapBytes.set(process.memoryUsage().heapUsed);
    return cached;
  }
  xlsxRuntimeCacheAccess.inc({ result: "miss" });
  const runtime = XlsxModelRuntime.fromWorkbook(graph, schema, sparseSnapshot);
  cacheRuntime(cacheKey, runtime);
  return runtime;
}

export function buildXlsxRuntime(
  cacheKey: string,
  graph: WorkbookGraph,
  schema: XlsxModelSchemaLike,
  sparseSnapshot?: SparseWorkbookSnapshot | null,
): RuntimeBuildResult {
  const result = XlsxModelRuntime.build(graph, schema, sparseSnapshot);
  cacheRuntime(cacheKey, result.runtime);
  return result;
}

export function clearXlsxRuntimeCache(): void {
  runtimeCache.clear();
  xlsxRuntimeCacheEntries.set(0);
  xlsxRuntimeProcessHeapBytes.set(process.memoryUsage().heapUsed);
}

/** Helper for tests / reprocess densifying stored sparse snapshots. */
export function densifyStoredSnapshot(sparse: SparseWorkbookSnapshot) {
  return densifySnapshot(sparse);
}
