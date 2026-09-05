/**
 * Generated from the committed Excel parity golden for HyperFormula 3.2.
 *
 * A function can be registered by HyperFormula yet still fail an Excel-style
 * formula used by our supported workbook surface. Keep this list synchronized
 * with `src/tests/fixtures/excel_parity_golden.json`; excelParity.test.ts
 * deliberately fails when runtime parity and this artifact diverge.
 */
export const PARITY_UNSUPPORTED_FUNCTIONS = new Set<string>([
  "VLOOKUP",
]);
