import { pool } from "../db/index.js";
import { buildContext as buildTextContext } from "./contextEngine.js";
import { buildExcelContext } from "./excelContextEngine.js";
import type { Scope } from "../middleware/workspace.js";

/**
 * Prefer executable XLSX spreadsheet models over newer CSV/text uploads.
 * CSV/text may enrich Excel context (business narrative) but must not
 * supersede an XLSX model as the executable engine.
 */
export async function buildContextForUser(scope: Scope) {
  let docsRes;
  try {
    docsRes = await pool.query(
      `SELECT document_id, document_kind
       FROM documents
       WHERE workspace_id = $1
         AND status = 'ready'
         AND document_kind = 'spreadsheet_model'
       ORDER BY created_at DESC
       LIMIT 1`,
      [scope.workspaceId],
    );
  } catch (e) {
    const err = e as { code?: string };
    if (err.code !== "42703") throw e;
    return buildTextContext(scope);
  }

  if (docsRes.rows.length > 0) {
    // Excel path also merges PDF/text narrative inside buildExcelContext
    return buildExcelContext(scope);
  }
  return buildTextContext(scope);
}
