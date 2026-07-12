/**
 * Re-extract workbook graphs + sparse formula snapshots for spreadsheet models
 * that have their original bytes stored. Run after extractor improvements:
 *
 *   npx tsx scripts/reprocess-workbooks.ts
 *
 * Documents uploaded before file persistence landed have no file_bytes and
 * must be re-uploaded by the user — they are listed at the end.
 *
 * Pre-v2 / legacy sparse snapshots without Excel-cached `expected` values will
 * not pass fidelity readiness for key outputs until reprocessed (or re-uploaded).
 */

import "dotenv/config";
import pg from "pg";
import { extractWorkbookArtifact } from "../src/services/excelExtractor.js";
import { ARTIFACT_VERSION, buildIngestionReport } from "../src/services/ingestionArtifacts.js";

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
      const artifact = await extractWorkbookArtifact(row.file_bytes as Buffer);
      const report = buildIngestionReport({
        document_kind: "spreadsheet_model",
        parser: "local",
        workbook: artifact,
      });
      await pool.query(
        `UPDATE documents
         SET workbook_graph = $1,
             workbook_snapshot = $2,
             ingestion_report = $3,
             artifact_version = $4,
             updated_at = NOW()
         WHERE document_id = $5`,
        [
          JSON.stringify(artifact.graph),
          JSON.stringify(artifact.snapshot),
          JSON.stringify(report),
          ARTIFACT_VERSION,
          row.document_id,
        ],
      );
      console.log(
        `✔ ${row.name}: re-extracted (${artifact.stats.cellCount} cells, ${artifact.stats.formulaCount} formulas, ${artifact.stats.crossSheetLinkCount} cross-sheet)`,
      );
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
