/**
 * S3-compatible object storage for workbook originals and large artifacts.
 * When unset, callers fall back to Postgres BYTEA (dual-read supported).
 */

import { config } from "../config.js";
import { logger } from "../logger.js";

export function isObjectStorageEnabled(): boolean {
  return Boolean(
    config.OBJECT_STORAGE_BUCKET &&
      config.OBJECT_STORAGE_ACCESS_KEY &&
      config.OBJECT_STORAGE_SECRET_KEY,
  );
}

async function getClient() {
  const { S3Client } = await import("@aws-sdk/client-s3");
  return new S3Client({
    region: config.OBJECT_STORAGE_REGION,
    endpoint: config.OBJECT_STORAGE_ENDPOINT || undefined,
    forcePathStyle: Boolean(config.OBJECT_STORAGE_FORCE_PATH_STYLE),
    credentials: {
      accessKeyId: config.OBJECT_STORAGE_ACCESS_KEY!,
      secretAccessKey: config.OBJECT_STORAGE_SECRET_KEY!,
    },
  });
}

export async function putObject(
  key: string,
  body: Buffer,
  contentType = "application/octet-stream",
): Promise<{ key: string; backend: "s3" }> {
  if (!isObjectStorageEnabled()) {
    throw new Error("Object storage is not configured");
  }
  const { PutObjectCommand } = await import("@aws-sdk/client-s3");
  const client = await getClient();
  await client.send(
    new PutObjectCommand({
      Bucket: config.OBJECT_STORAGE_BUCKET!,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
  return { key, backend: "s3" };
}

export async function getObject(key: string): Promise<Buffer | null> {
  if (!isObjectStorageEnabled()) return null;
  try {
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    const client = await getClient();
    const res = await client.send(
      new GetObjectCommand({
        Bucket: config.OBJECT_STORAGE_BUCKET!,
        Key: key,
      }),
    );
    const bytes = await res.Body?.transformToByteArray();
    return bytes ? Buffer.from(bytes) : null;
  } catch (e) {
    logger.warn({ detail: (e as Error).message, key }, "[ObjectStorage] getObject failed");
    return null;
  }
}

export async function getSignedObjectUrl(key: string, expiresInSec = 3600): Promise<string | null> {
  if (!isObjectStorageEnabled()) return null;
  try {
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
    const client = await getClient();
    return getSignedUrl(
      client,
      new GetObjectCommand({
        Bucket: config.OBJECT_STORAGE_BUCKET!,
        Key: key,
      }),
      { expiresIn: expiresInSec },
    );
  } catch (e) {
    logger.warn({ detail: (e as Error).message, key }, "[ObjectStorage] signed URL failed");
    return null;
  }
}

/** Prefer object storage when configured; otherwise return null so caller uses BYTEA. */
export async function storeWorkbookBytes(
  workspaceId: string,
  documentId: string,
  buffer: Buffer,
  contentType: string,
): Promise<{ storage_key: string; storage_backend: "s3" } | null> {
  if (!isObjectStorageEnabled()) return null;
  const key = `workspaces/${workspaceId}/documents/${documentId}/original`;
  await putObject(key, buffer, contentType);
  return { storage_key: key, storage_backend: "s3" };
}

/** Alias for getSignedObjectUrl (documents route). */
export async function getSignedUrl(key: string, expiresInSec = 3600): Promise<string | null> {
  return getSignedObjectUrl(key, expiresInSec);
}

/**
 * Dual-read original bytes: storage_key → S3, else Postgres BYTEA.
 */
export async function loadDocumentBytes(doc: {
  document_id: string;
  storage_key?: string | null;
  file_bytes?: Buffer | Uint8Array | null;
}): Promise<Buffer | null> {
  if (doc.storage_key) {
    const fromS3 = await getObject(doc.storage_key);
    if (fromS3) return fromS3;
  }
  if (doc.file_bytes) {
    return Buffer.isBuffer(doc.file_bytes) ? doc.file_bytes : Buffer.from(doc.file_bytes);
  }
  return null;
}

/**
 * Backfill documents that still only have BYTEA into object storage.
 * Callable from scripts/ or admin tooling.
 */
export async function backfillDocumentsToObjectStorage(opts?: {
  limit?: number;
}): Promise<{ migrated: number; skipped: number; errors: number }> {
  if (!isObjectStorageEnabled()) {
    return { migrated: 0, skipped: 0, errors: 0 };
  }
  const { pool } = await import("../db/index.js");
  const limit = opts?.limit ?? 100;
  const r = await pool.query(
    `SELECT document_id, workspace_id, file_bytes, file_type, storage_key
     FROM documents
     WHERE file_bytes IS NOT NULL
       AND (storage_key IS NULL OR storage_backend = 'postgres')
     ORDER BY created_at ASC
     LIMIT $1`,
    [limit],
  );
  let migrated = 0;
  let skipped = 0;
  let errors = 0;
  for (const row of r.rows) {
    if (!row.workspace_id || !row.file_bytes) {
      skipped += 1;
      continue;
    }
    try {
      const buf = Buffer.isBuffer(row.file_bytes)
        ? row.file_bytes
        : Buffer.from(row.file_bytes);
      const stored = await storeWorkbookBytes(
        row.workspace_id,
        row.document_id,
        buf,
        row.file_type || "application/octet-stream",
      );
      if (!stored) {
        skipped += 1;
        continue;
      }
      await pool.query(
        `UPDATE documents SET storage_key = $2, storage_backend = $3 WHERE document_id = $1`,
        [row.document_id, stored.storage_key, stored.storage_backend],
      );
      migrated += 1;
    } catch (e) {
      errors += 1;
      logger.warn(
        { detail: (e as Error).message, document_id: row.document_id },
        "[ObjectStorage] backfill failed",
      );
    }
  }
  return { migrated, skipped, errors };
}
