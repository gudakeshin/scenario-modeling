/**
 * XLSX Model Runtime — real cell-level simulation via HyperFormula.
 *
 * Hydrates from densified sparse workbook snapshots, binds levers/outputs by
 * explicit cell addresses (schema or candidates), and surfaces structured
 * build/binding/evaluation errors instead of silent null/zero fallbacks.
 */

import { HyperFormula, DetailedCellError } from "hyperformula";
import { config } from "../config.js";
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
  cell: string;
}

interface OutputBinding extends CellAddress {
  id: string;
  label: string;
  sheet: string;
  cell: string;
}

export interface XlsxModelSchemaLike {
  scenarioLevers?: Array<{
    id: string;
    label?: string;
    sheet?: string;
    cell?: string;
    scenarios?: { base?: number };
  }>;
  outputMetrics?: Array<{
    id: string;
    label?: string;
    sheet?: string;
    row?: number;
    cell?: string;
  }>;
  baseValues?: Record<string, number>;
}

export type RuntimeFailureReason =
  | "missing_snapshot"
  | "hyperformula_build"
  | "no_lever_bindings"
  | "no_output_bindings"
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
}

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
    for (const name of Object.keys(snapshot)) {
      const id = hf.getSheetId(name);
      if (id != null) sheetIdByName.set(name, id);
    }

    const candidateById = new Map(
      (graph.inputCandidates || []).map((c) => [toId(c.id || c.label || ""), c]),
    );
    const outputCandidateById = new Map(
      (graph.outputCandidates || []).map((c) => [toId(c.id || c.label || ""), c]),
    );

    const levers: LeverBinding[] = [];
    const unboundLevers: string[] = [];
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
      levers.push({
        id,
        label: lever.label || lever.id,
        base: Number(lever.scenarios?.base ?? cand?.value ?? 0),
        sheetId,
        row: pos.row,
        col: pos.col,
        sheet,
        cell,
      });
    }

    const outputs: OutputBinding[] = [];
    const unboundOutputs: string[] = [];
    for (const metric of schema.outputMetrics || []) {
      const id = toId(metric.id);
      const cand = outputCandidateById.get(id);
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
      outputs.push({
        id,
        label: metric.label || metric.id,
        sheetId,
        row: pos.row,
        col: pos.col,
        sheet,
        cell,
      });
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

  evaluate(absoluteOverrides: Record<string, number>): Record<string, number> {
    this.lastEvaluationErrors.length = 0;
    this.lastIgnoredOverrides.length = 0;
    const touched: Array<{ binding: LeverBinding; previous: unknown }> = [];

    try {
      for (const [id, value] of Object.entries(absoluteOverrides)) {
        const binding = this.levers.get(toId(id));
        if (!binding || !Number.isFinite(value)) {
          if (Number.isFinite(value)) this.lastIgnoredOverrides.push(id);
          continue;
        }
        const previous = this.hf.getCellValue({
          sheet: binding.sheetId,
          row: binding.row,
          col: binding.col,
        });
        this.hf.setCellContents(
          { sheet: binding.sheetId, row: binding.row, col: binding.col },
          [[value]],
        );
        touched.push({ binding, previous });
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
        const v = this.hf.getCellValue({ sheet: out.sheetId, row: out.row, col: out.col });
        if (isCellError(v)) {
          this.lastEvaluationErrors.push(`Output ${out.id} (${out.sheet}!${out.cell}): ${cellErrorMessage(v)}`);
          // Do not silently invent 0 — use NaN marker converted to nullish handling upstream;
          // keep numeric contract with NaN filtered by callers via Number.isFinite checks.
          result[out.id] = Number.NaN;
        } else if (typeof v === "number" && Number.isFinite(v)) {
          result[out.id] = v;
        } else {
          this.lastEvaluationErrors.push(
            `Output ${out.id} (${out.sheet}!${out.cell}) is non-numeric: ${String(v)}`,
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
   */
  evaluatePeriods(absoluteOverrides: Record<string, number>): PeriodSlice[] {
    if (this.periodColumns.length === 0) {
      return [{ period: "FY", values: this.evaluate(absoluteOverrides) }];
    }

    this.lastEvaluationErrors.length = 0;
    const touched: Array<{ binding: LeverBinding; previous: unknown }> = [];

    try {
      for (const [id, value] of Object.entries(absoluteOverrides)) {
        const binding = this.levers.get(toId(id));
        if (!binding || !Number.isFinite(value)) continue;
        const previous = this.hf.getCellValue({
          sheet: binding.sheetId,
          row: binding.row,
          col: binding.col,
        });
        this.hf.setCellContents(
          { sheet: binding.sheetId, row: binding.row, col: binding.col },
          [[value]],
        );
        touched.push({ binding, previous });
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

const CACHE_MAX = 10;
const runtimeCache = new Map<string, XlsxModelRuntime | null>();

export function getXlsxRuntime(
  cacheKey: string,
  graph: WorkbookGraph,
  schema: XlsxModelSchemaLike,
  sparseSnapshot?: SparseWorkbookSnapshot | null,
): XlsxModelRuntime | null {
  if (runtimeCache.has(cacheKey)) return runtimeCache.get(cacheKey) ?? null;
  const runtime = XlsxModelRuntime.fromWorkbook(graph, schema, sparseSnapshot);
  if (runtimeCache.size >= CACHE_MAX) {
    const oldest = runtimeCache.keys().next().value;
    if (oldest !== undefined) runtimeCache.delete(oldest);
  }
  runtimeCache.set(cacheKey, runtime);
  return runtime;
}

export function buildXlsxRuntime(
  cacheKey: string,
  graph: WorkbookGraph,
  schema: XlsxModelSchemaLike,
  sparseSnapshot?: SparseWorkbookSnapshot | null,
): RuntimeBuildResult {
  const result = XlsxModelRuntime.build(graph, schema, sparseSnapshot);
  if (runtimeCache.size >= CACHE_MAX) {
    const oldest = runtimeCache.keys().next().value;
    if (oldest !== undefined) runtimeCache.delete(oldest);
  }
  runtimeCache.set(cacheKey, result.runtime);
  return result;
}

export function clearXlsxRuntimeCache(): void {
  runtimeCache.clear();
}

/** Helper for tests / reprocess densifying stored sparse snapshots. */
export function densifyStoredSnapshot(sparse: SparseWorkbookSnapshot) {
  return densifySnapshot(sparse);
}
