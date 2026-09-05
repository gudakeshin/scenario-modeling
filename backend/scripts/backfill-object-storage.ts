/**
 * CLI: migrate document BYTEA originals into object storage.
 * Usage: npx tsx scripts/backfill-object-storage.ts [--limit=100]
 */
import { backfillDocumentsToObjectStorage, isObjectStorageEnabled } from "../src/services/objectStorage.js";

async function main() {
  const limitArg = process.argv.find((a) => a.startsWith("--limit="));
  const limit = limitArg ? parseInt(limitArg.split("=")[1], 10) : 100;
  if (!isObjectStorageEnabled()) {
    console.error("Object storage is not configured (OBJECT_STORAGE_* env vars).");
    process.exit(1);
  }
  const result = await backfillDocumentsToObjectStorage({ limit });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.errors > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
