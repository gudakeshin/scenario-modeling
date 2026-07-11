/**
 * Re-extract workbook graphs (incl. cell snapshots) for spreadsheet models
 * that have their original bytes stored. Run after extractor improvements:
 *
 *   npx tsx scripts/reprocess-workbooks.ts
 *
 * Documents uploaded before file persistence landed have no file_bytes and
 * must be re-uploaded by the user — they are listed at the end.
 */

import "dotenv/config";
import pg from "pg";
import { extractWorkbookGraph } from "../src/services/excelExtractor.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const docs = await pool.query(
    `SELECT document_id, name, file_bytes
     FROM documents
     WHERE document_kind = 'spreadsheet_model' AND status = 'ready'
     ORDER BY created_at`,
  );

  let updated = 0;
  const needsReupload: string[] = [];

  for (const row of docs.rows) {
    if (!row.file_bytes) {
      needsReupload.push(`${row.name} (${row.document_id})`);
      continue;
    }
    try {
      const graph = await extractWorkbookGraph(row.file_bytes as Buffer);
      await pool.query(
        "UPDATE documents SET workbook_graph = $1, updated_at = NOW() WHERE document_id = $2",
        [JSON.stringify(graph), row.document_id],
      );
      const cells = graph.cellSnapshot
        ? Object.values(graph.cellSnapshot).reduce((s, g) => s + g.reduce((r, c) => r + c.length, 0), 0)
        : 0;
      console.log(`✔ ${row.name}: re-extracted (${cells} cells snapshotted)`);
      updated++;
    } catch (e) {
      console.error(`✖ ${row.name}: ${(e as Error).message}`);
    }
  }

  console.log(`\n${updated} document(s) re-processed.`);
  if (needsReupload.length > 0) {
    console.log(`\nNo stored bytes (user must re-upload):`);
    for (const d of needsReupload) console.log(`  - ${d}`);
  }
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
