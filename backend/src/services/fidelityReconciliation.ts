/**
 * Fidelity reconciliation — compare HyperFormula baseline values against
 * Excel-cached `expected` values stored on SparseCell (artifact v2).
 */

import { HyperFormula, DetailedCellError } from "hyperformula";
import { config } from "../config.js";
import {
  densifySnapshot,
  type SparseWorkbookSnapshot,
} from "./ingestionArtifacts.js";

export interface FidelityKeyOutput {
  id?: string;
  sheet: string;
  cell: string;
}

export interface FidelityDivergence {
  sheet: string;
  cell: string;
  expected: number;
  actual: number;
  abs_delta: number;
  rel_delta: number;
  is_key_output?: boolean;
}

export interface FidelityUnsupportedCell {
  sheet: string;
  cell: string;
  reason: string;
  formula?: string;
}

export interface FidelityReport {
  score: number;
  key_output_score: number;
  divergences: FidelityDivergence[];
  unsupported_cells: FidelityUnsupportedCell[];
  missing_expected_key_outputs: FidelityKeyOutput[];
  ready: boolean;
  compared_cells: number;
  key_outputs_compared: number;
}

function colToLetter(col: number): string {
  let n = col + 1;
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export function parseA1(ref: string): { row: number; col: number } | null {
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
  return (
    v instanceof DetailedCellError ||
    (typeof v === "object" &&
      v != null &&
      "type" in (v as object) &&
      "message" in (v as object))
  );
}

/** Within abs OR relative tolerance (whichever is larger). */
export function withinFidelityTolerance(
  actual: number,
  expected: number,
  absTol = config.FIDELITY_ABS_TOLERANCE,
  relTol = config.FIDELITY_REL_TOLERANCE,
): boolean {
  if (!Number.isFinite(actual) || !Number.isFinite(expected)) return false;
  const absDelta = Math.abs(actual - expected);
  const threshold = Math.max(absTol, relTol * Math.abs(expected));
  return absDelta <= threshold;
}

/**
 * Reconcile HyperFormula-evaluated cells against sparse snapshot expected values.
 * Legacy snapshots with no `expected` fields do not block readiness.
 */
export function reconcileFidelity(
  sparse: SparseWorkbookSnapshot | null | undefined,
  keyOutputs: FidelityKeyOutput[] = [],
  opts?: {
    absTol?: number;
    relTol?: number;
    readyThreshold?: number;
  },
): FidelityReport {
  const absTol = opts?.absTol ?? config.FIDELITY_ABS_TOLERANCE;
  const relTol = opts?.relTol ?? config.FIDELITY_REL_TOLERANCE;
  const readyThreshold = opts?.readyThreshold ?? config.FIDELITY_READY_THRESHOLD;

  const empty: FidelityReport = {
    score: 1,
    key_output_score: 1,
    divergences: [],
    unsupported_cells: [],
    missing_expected_key_outputs: [],
    ready: true,
    compared_cells: 0,
    key_outputs_compared: 0,
  };

  if (!sparse || sparse.cellCount === 0) return empty;

  const dense = densifySnapshot(sparse);
  let hf: HyperFormula;
  try {
    hf = HyperFormula.buildFromSheets(dense as Record<string, (string | number | null)[][]>, {
      licenseKey: "gpl-v3",
      useColumnIndex: false,
    });
  } catch (e) {
    return {
      score: 0,
      key_output_score: 0,
      divergences: [],
      unsupported_cells: [
        {
          sheet: "",
          cell: "",
          reason: `HyperFormula build failed: ${(e as Error).message}`,
        },
      ],
      missing_expected_key_outputs: [],
      ready: false,
      compared_cells: 0,
      key_outputs_compared: 0,
    };
  }

  const divergences: FidelityDivergence[] = [];
  const unsupported_cells: FidelityUnsupportedCell[] = [];
  let compared = 0;
  let matched = 0;

  const keySet = new Map<string, FidelityKeyOutput>();
  for (const ko of keyOutputs) {
    if (!ko.sheet || !ko.cell) continue;
    keySet.set(`${ko.sheet}!${ko.cell.replace(/\$/g, "").toUpperCase()}`, ko);
  }

  let keyCompared = 0;
  let keyMatched = 0;
  const keyDivergences: FidelityDivergence[] = [];

  for (const sheetName of sparse.sheetOrder) {
    const sheet = sparse.sheets[sheetName];
    if (!sheet) continue;
    const sheetId = hf.getSheetId(sheetName);
    if (sheetId == null) continue;

    for (const cell of sheet.cells) {
      const a1 = `${colToLetter(cell.c)}${cell.r + 1}`;
      const key = `${sheetName}!${a1}`;
      const isFormula =
        typeof cell.v === "string" && String(cell.v).trim().startsWith("=");

      const hfVal = hf.getCellValue({ sheet: sheetId, row: cell.r, col: cell.c });

      if (isFormula && isCellError(hfVal)) {
        unsupported_cells.push({
          sheet: sheetName,
          cell: a1,
          reason: `${(hfVal as DetailedCellError).type || "ERROR"}: ${(hfVal as DetailedCellError).message || "cell error"}`,
          formula: String(cell.v),
        });
      }

      if (cell.expected == null || !Number.isFinite(cell.expected)) continue;

      compared++;
      const actual =
        typeof hfVal === "number" && Number.isFinite(hfVal)
          ? hfVal
          : Number.NaN;

      const ok = withinFidelityTolerance(actual, cell.expected, absTol, relTol);
      if (ok) {
        matched++;
      } else {
        const absDelta = Number.isFinite(actual)
          ? Math.abs(actual - cell.expected)
          : Number.POSITIVE_INFINITY;
        const relDelta =
          Math.abs(cell.expected) > 1e-12
            ? absDelta / Math.abs(cell.expected)
            : absDelta;
        divergences.push({
          sheet: sheetName,
          cell: a1,
          expected: cell.expected,
          actual: Number.isFinite(actual) ? actual : Number.NaN,
          abs_delta: absDelta,
          rel_delta: relDelta,
          is_key_output: keySet.has(key),
        });
      }

      if (keySet.has(key)) {
        keyCompared++;
        if (ok) keyMatched++;
        else {
          const absDelta = Number.isFinite(actual)
            ? Math.abs(actual - cell.expected)
            : Number.POSITIVE_INFINITY;
          const relDelta =
            Math.abs(cell.expected) > 1e-12
              ? absDelta / Math.abs(cell.expected)
              : absDelta;
          keyDivergences.push({
            sheet: sheetName,
            cell: a1,
            expected: cell.expected,
            actual: Number.isFinite(actual) ? actual : Number.NaN,
            abs_delta: absDelta,
            rel_delta: relDelta,
            is_key_output: true,
          });
        }
      }
    }
  }

  // Key outputs without Excel-cached expected values cannot silently earn readiness.
  const missing_expected_key_outputs: FidelityKeyOutput[] = [];
  for (const [ref, ko] of keySet) {
    const already = [...keyDivergences, ...divergences].some(
      (d) => `${d.sheet}!${d.cell}` === ref && d.is_key_output,
    );
    if (already) continue;
    const parsed = parseA1(ko.cell);
    if (!parsed) {
      missing_expected_key_outputs.push(ko);
      continue;
    }
    const sheetSnap = sparse.sheets[ko.sheet];
    const sparseCell = sheetSnap?.cells.find(
      (c) => c.r === parsed.row && c.c === parsed.col,
    );
    if (sparseCell?.expected == null || !Number.isFinite(sparseCell.expected)) {
      missing_expected_key_outputs.push(ko);
    }
  }

  const score = compared === 0 ? (keySet.size > 0 ? 0 : 1) : matched / compared;
  const key_output_score = keyCompared === 0 ? (keySet.size > 0 ? 0 : 1) : keyMatched / keyCompared;
  const keyOutputsOk =
    keySet.size === 0
      ? true
      : missing_expected_key_outputs.length === 0 &&
        keyCompared > 0 &&
        key_output_score >= 1;
  const unsupportedBlocks =
    unsupported_cells.length > 0 &&
    (keySet.size === 0 ||
      unsupported_cells.some((u) => keySet.has(`${u.sheet}!${u.cell}`)));
  const ready =
    keyOutputsOk &&
    !unsupportedBlocks &&
    (compared === 0 ? keySet.size === 0 : score >= readyThreshold);

  // Prefer surfacing key divergences first
  const orderedDivergences = [
    ...keyDivergences,
    ...divergences.filter((d) => !d.is_key_output),
  ].slice(0, 50);

  return {
    score: Math.round(score * 1000) / 1000,
    key_output_score: Math.round(key_output_score * 1000) / 1000,
    divergences: orderedDivergences,
    unsupported_cells: unsupported_cells.slice(0, 50),
    missing_expected_key_outputs,
    ready,
    compared_cells: compared,
    key_outputs_compared: keyCompared,
  };
}
