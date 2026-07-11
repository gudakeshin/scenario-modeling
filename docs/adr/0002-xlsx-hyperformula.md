# ADR 0002: XLSX simulation via HyperFormula

## Status

Accepted

## Context

Financial models often arrive as Excel workbooks. Formula-DAG approximations diverge from real spreadsheet behavior (cross-sheet refs, native functions). Users expect scenario deltas to propagate like Excel.

## Decision

At upload, extract a full cell snapshot / workbook graph and run scenarios through **HyperFormula** (`XlsxModelRuntime`) for real cell-level recalculation. Compiled formula models remain available for non-XLSX paths.

## Consequences

- Workbooks uploaded before structural extraction lack graphs — **re-upload** or run `backend/scripts/reprocess-workbooks.ts`.
- HyperFormula coverage is broad but not 100% of Excel; unsupported formulas should surface as runtime errors rather than silent wrong numbers.
- Runtime instances are cached carefully because builds are expensive.
