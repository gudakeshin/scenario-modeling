import { createRequire } from "node:module";
import type { Redis } from "ioredis";
import { Queue } from "bullmq";
import { config } from "../config.js";

export const INGESTION_QUEUE_NAME = "document-ingestion";

export interface IngestionJobData {
  documentId: string;
}

const require = createRequire(import.meta.url);
const RedisCtor = (require("ioredis").default ?? require("ioredis")) as new (
  url: string,
  options: { maxRetriesPerRequest: null; enableReadyCheck: boolean },
) => Redis;

let connection: Redis | null = null;
let queue: Queue<IngestionJobData> | null = null;

export function isAsyncIngestionEnabled(): boolean {
  const enabled =
    config.INGESTION_ASYNC_ENABLED ??
    (config.NODE_ENV !== "test" && Boolean(config.REDIS_URL));
  return enabled && Boolean(config.REDIS_URL);
}

export function getIngestionConnection(): Redis {
  if (!config.REDIS_URL) throw new Error("REDIS_URL is required for async ingestion");
  return new RedisCtor(config.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });
}

export function getIngestionQueue(): Queue<IngestionJobData> {
  if (!queue) {
    connection = getIngestionConnection();
    queue = new Queue<IngestionJobData>(INGESTION_QUEUE_NAME, {
      connection,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 5_000 },
        removeOnComplete: { age: 86_400, count: 1_000 },
        removeOnFail: { age: 604_800, count: 5_000 },
      },
    });
  }
  return queue;
}

export async function enqueueDocumentIngestion(documentId: string): Promise<void> {
  await getIngestionQueue().add(
    "ingest",
    { documentId },
    { jobId: `document:${documentId}` },
  );
}

export async function closeIngestionQueue(): Promise<void> {
  await queue?.close();
  await connection?.quit();
  queue = null;
  connection = null;
}
