# ADR 0002: XLSX simulation via HyperFormula

## Status

Accepted (updated for formula-preserving ingestion)

## Context

Financial models often arrive as Excel workbooks. Formula-DAG approximations diverge from real spreadsheet behavior (cross-sheet refs, native functions). Users expect scenario deltas to propagate like Excel. Chunking Excel to text for RAG strips formulas and must never be the executable model source.

## Decision

1. At upload, extract a **WorkbookArtifact**: semantic `workbook_graph` metadata plus a **sparse `workbook_snapshot`** that preserves exact formula strings and cross-sheet links for every non-empty cell (no silent drop at a cell-count cutoff).
2. Persist original `file_bytes` as the immutable source of truth; reprocess via `backend/scripts/reprocess-workbooks.ts`.
3. Run scenarios through **HyperFormula** (`XlsxModelRuntime`) hydrated from the densified sparse snapshot. Lever/output bindings use explicit `sheet` + `cell` addresses on `model_schema`.
4. Analyst validation must prove the runtime builds and baseline evaluation succeeds before `validation_status = ready`.
5. CSV uploads are **tabular_data** only: typed single-sheet artifacts with no invented formulas or worksheet links. They must not supersede an executable XLSX model.
6. The constants-only `user_models` row for XLSX is a **catalog** (`source_kind = xlsx_catalog`), not an executable formula DAG.

## Consequences

- Workbooks uploaded before sparse snapshots / `file_bytes` need **re-upload** or reprocess.
- HyperFormula coverage is broad but not 100% of Excel; unsupported formulas and cell errors surface in ingestion reports / validation / simulation notices rather than silent zeros.
- Large workbooks warn but still retain sparse formula snapshots.
- Denomination (Crore / Lakh / Lac / Million / …) is detected per sheet/document and rescaled into a canonical store unit (Million) via `toCanonical()` at ingestion; mixed currencies require an explicit FX assumption.
