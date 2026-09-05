import { Worker, UnrecoverableError } from "bullmq";
import { config } from "./config.js";
import { pool } from "./db/index.js";
import { logger } from "./logger.js";
import {
  getIngestionConnection,
  INGESTION_QUEUE_NAME,
  type IngestionJobData,
} from "./queue/ingestionQueue.js";
import {
  getDocumentOriginalBytes,
  processQueuedDocument,
} from "./services/documentService.js";
import { scanBuffer } from "./services/virusScanService.js";

if (!config.REDIS_URL) {
  throw new Error("Worker requires REDIS_URL");
}

const connection = getIngestionConnection();
const worker = new Worker<IngestionJobData>(
  INGESTION_QUEUE_NAME,
  async (job) => {
    const { documentId } = job.data;
    await job.updateProgress({ percent: 2, stage: "virus_scan" });
    const original = await getDocumentOriginalBytes(documentId);
    if (!original) throw new UnrecoverableError("Original document bytes not found");

    const scan = await scanBuffer(original.bytes);
    if (scan.status === "infected") {
      await pool.query(
        `UPDATE documents
         SET status = 'rejected', validation_status = 'error', progress = 100,
             processing_error = $2, processing_completed_at = NOW(), updated_at = NOW()
         WHERE document_id = $1`,
        [documentId, `Malware detected: ${scan.signature || "unknown signature"}`],
      );
      throw new UnrecoverableError(`Malware detected: ${scan.signature || "unknown"}`);
    }

    let timeout: NodeJS.Timeout | undefined;
    try {
      timeout = setTimeout(() => {
        logger.fatal(
          { documentId, timeoutMs: config.INGESTION_JOB_TIMEOUT_MS },
          "Ingestion timed out; terminating worker so BullMQ can retry safely",
        );
        process.exit(1);
      }, config.INGESTION_JOB_TIMEOUT_MS);
      timeout.unref();
      return await processQueuedDocument(documentId, async (percent, stage) => {
        await job.updateProgress({ percent, stage });
      });
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  },
  {
    connection,
    concurrency: 1,
    lockDuration: Math.max(config.INGESTION_JOB_TIMEOUT_MS + 60_000, 360_000),
  },
);

worker.on("completed", (job) => {
  logger.info({ jobId: job.id, documentId: job.data.documentId }, "Ingestion completed");
});
worker.on("failed", async (job, error) => {
  logger.error({ err: error, jobId: job?.id, documentId: job?.data.documentId }, "Ingestion failed");
  const attempts = Number(job?.opts.attempts ?? 1);
  if (job && job.attemptsMade >= attempts) {
    await pool.query(
      `UPDATE documents
       SET status = CASE WHEN status = 'rejected' THEN status ELSE 'error' END,
           validation_status = 'error', progress = 100,
           processing_error = COALESCE(processing_error, $2),
           processing_completed_at = NOW(), updated_at = NOW()
       WHERE document_id = $1`,
      [job.data.documentId, error.message],
    );
  }
});

async function shutdown(signal: string) {
  logger.info({ signal }, "Stopping ingestion worker");
  await worker.close();
  await connection.quit();
  await pool.end();
  process.exit(0);
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

logger.info({ queue: INGESTION_QUEUE_NAME }, "Ingestion worker started");
