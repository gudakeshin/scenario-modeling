/**
 * XLSX Model Runtime — real cell-level simulation via HyperFormula.
 *
 * Builds a HyperFormula instance from the full cell snapshot captured at
 * ingest (excelExtractor.cellSnapshot), maps scenario levers to their
 * source cells and output metrics to their result cells, and evaluates
 * overrides by setting lever cells and reading recalculated outputs.
 *
 * This replaces the old "average delta" heuristic, under which every
 * output moved by the mean of all lever deltas regardless of the
 * workbook's actual formula structure (and Monte Carlo / sensitivity on
 * XLSX models returned zero variance).
 */

import { HyperFormula } from "hyperformula";
import type { WorkbookGraph } from "./excelExtractor.js";
import type { EvaluableModel, ModelInput } from "./expression.js";

interface CellAddress {
  sheetId: number;
  row: number; // 0-indexed
  col: number; // 0-indexed
}

interface LeverBinding extends CellAddress {
  id: string;
  label: string;
  base: number;
}

interface OutputBinding extends CellAddress {
  id: string;
  label: string;
}

/** Minimal shape of the model_schema stored on the document. */
export interface XlsxModelSchemaLike {
  scenarioLevers?: Array<{ id: string; label?: string; scenarios?: { base?: number } }>;
  outputMetrics?: Array<{ id: string; label?: string; sheet?: string; row?: number }>;
  baseValues?: Record<string, number>;
}

function toId(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

/** Parse "B12" → { col: 1, row: 11 } (0-indexed). */
function parseCellRef(ref: string): { row: number; col: number } | null {
  const m = ref.replace(/\$/g, "").match(/^([A-Z]{1,3})(\d+)$/i);
  if (!m) return null;
  let col = 0;
  const letters = m[1].toUpperCase();
  for (let i = 0; i < letters.length; i++) {
    col = col * 26 + (letters.charCodeAt(i) - 64);
  }
  return { row: parseInt(m[2], 10) - 1, col: col - 1 };
}

export class XlsxModelRuntime implements EvaluableModel {
  readonly kind = "xlsx" as const;
  readonly inputs: ModelInput[];
  readonly outputIds: string[];

  private hf: HyperFormula;
  private levers: Map<string, LeverBinding>;
  private outputs: OutputBinding[];

  private constructor(hf: HyperFormula, levers: LeverBinding[], outputs: OutputBinding[]) {
    this.hf = hf;
    this.levers = new Map(levers.map((l) => [l.id, l]));
    this.outputs = outputs;
    this.inputs = levers.map((l) => ({ id: l.id, name: l.label, base: l.base }));
    this.outputIds = outputs.map((o) => o.id);
  }

  /**
   * Build a runtime from a workbook graph + model schema.
   * Returns null when the document lacks a cell snapshot (uploaded before
   * cell capture landed, or the workbook exceeded the snapshot limit) or
   * when no lever/output can be bound to a cell.
   */
  static fromWorkbook(graph: WorkbookGraph, schema: XlsxModelSchemaLike): XlsxModelRuntime | null {
    const snapshot = graph.cellSnapshot;
    if (!snapshot || Object.keys(snapshot).length === 0) return null;

    let hf: HyperFormula;
    try {
      hf = HyperFormula.buildFromSheets(snapshot as Record<string, (string | number | null)[][]>, {
        licenseKey: "gpl-v3",
        useColumnIndex: false,
      });
    } catch {
      return null;
    }

    const sheetIdByName = new Map<string, number>();
    for (const name of Object.keys(snapshot)) {
      const id = hf.getSheetId(name);
      if (id != null) sheetIdByName.set(name, id);
    }

    // Bind levers to input candidate cells (matched by normalized id).
    const candidateById = new Map(
      (graph.inputCandidates || []).map((c) => [toId(c.id || c.label || ""), c]),
    );
    const levers: LeverBinding[] = [];
    for (const lever of schema.scenarioLevers || []) {
      const cand = candidateById.get(toId(lever.id));
      if (!cand) continue;
      const sheetId = sheetIdByName.get(cand.sheet);
      const pos = parseCellRef(cand.cell);
      if (sheetId == null || !pos) continue;
      levers.push({
        id: toId(lever.id),
        label: lever.label || lever.id,
        base: Number(lever.scenarios?.base ?? cand.value ?? 0),
        sheetId,
        row: pos.row,
        col: pos.col,
      });
    }

    // Bind outputs to output candidate cells.
    const outputCandidateById = new Map(
      (graph.outputCandidates || []).map((c) => [toId(c.id || c.label || ""), c]),
    );
    const outputs: OutputBinding[] = [];
    for (const metric of schema.outputMetrics || []) {
      const cand = outputCandidateById.get(toId(metric.id));
      if (!cand || !cand.cell) continue;
      const sheetId = sheetIdByName.get(cand.sheet);
      const pos = parseCellRef(cand.cell);
      if (sheetId == null || !pos) continue;
      outputs.push({
        id: toId(metric.id),
        label: metric.label || metric.id,
        sheetId,
        row: pos.row,
        col: pos.col,
      });
    }

    if (levers.length === 0 || outputs.length === 0) return null;
    return new XlsxModelRuntime(hf, levers, outputs);
  }

  /**
   * Evaluate with ABSOLUTE lever values. Unknown override keys are ignored.
   * Lever cells are restored afterwards, so the instance is reusable
   * (Monte Carlo calls this thousands of times).
   */
  evaluate(absoluteOverrides: Record<string, number>): Record<string, number> {
    const touched: Array<{ binding: LeverBinding; previous: number | string | boolean | null }> = [];

    try {
      for (const [id, value] of Object.entries(absoluteOverrides)) {
        const binding = this.levers.get(toId(id));
        if (!binding || !Number.isFinite(value)) continue;
        const previous = this.hf.getCellValue({ sheet: binding.sheetId, row: binding.row, col: binding.col });
        this.hf.setCellContents({ sheet: binding.sheetId, row: binding.row, col: binding.col }, [[value]]);
        touched.push({ binding, previous: previous as number | string | boolean | null });
      }

      const result: Record<string, number> = {};
      for (const lever of this.levers.values()) {
        const v = this.hf.getCellValue({ sheet: lever.sheetId, row: lever.row, col: lever.col });
        result[lever.id] = typeof v === "number" && Number.isFinite(v) ? v : lever.base;
      }
      for (const out of this.outputs) {
        const v = this.hf.getCellValue({ sheet: out.sheetId, row: out.row, col: out.col });
        result[out.id] = typeof v === "number" && Number.isFinite(v) ? v : 0;
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
}

// ── Runtime cache (HyperFormula builds are expensive) ──

const CACHE_MAX = 10;
const runtimeCache = new Map<string, XlsxModelRuntime | null>();

/**
 * Get (or build) the cached runtime for a document. Cache key includes the
 * document's updated_at so re-processing invalidates stale entries.
 */
export function getXlsxRuntime(
  cacheKey: string,
  graph: WorkbookGraph,
  schema: XlsxModelSchemaLike,
): XlsxModelRuntime | null {
  if (runtimeCache.has(cacheKey)) return runtimeCache.get(cacheKey) ?? null;
  const runtime = XlsxModelRuntime.fromWorkbook(graph, schema);
  if (runtimeCache.size >= CACHE_MAX) {
    const oldest = runtimeCache.keys().next().value;
    if (oldest !== undefined) runtimeCache.delete(oldest);
  }
  runtimeCache.set(cacheKey, runtime);
  return runtime;
}
