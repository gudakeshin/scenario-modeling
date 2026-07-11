import { pool, resolveUserId } from "../db/index.js";
import { buildContext as buildTextContext } from "./contextEngine.js";
import { buildExcelContext } from "./excelContextEngine.js";

export async function buildContextForUser(userIdentifier: string) {
  const userId = await resolveUserId(userIdentifier);
  let docsRes;
  try {
    docsRes = await pool.query(
      `SELECT document_id
       FROM documents
       WHERE created_by = $1
         AND status = 'ready'
         AND document_kind = 'spreadsheet_model'
       ORDER BY created_at DESC
       LIMIT 1`,
      [userId],
    );
  } catch (e) {
    const err = e as { code?: string };
    if (err.code !== "42703") throw e;
    return buildTextContext(userIdentifier);
  }

  if (docsRes.rows.length > 0) {
    return buildExcelContext(userIdentifier);
  }
  return buildTextContext(userIdentifier);
}
