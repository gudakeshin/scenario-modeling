/**
 * Document Service
 *
 * Orchestrates upload ingestion:
 *  - XLSX → formula-preserving WorkbookArtifact (graph + sparse snapshot)
 *  - CSV   → typed TabularArtifact (data-only, no formulas)
 *  - Other → text document for RAG
 *
 * document_chunks are a secondary search representation only and never rebuild
 * the executable spreadsheet model.
 */

import { pool } from "../db/index.js";
import type { Role } from "../auth/provider.js";
import { randomUUID } from "crypto";
import { parse as parseCsv } from "csv-parse/sync";
import {
  extractWorkbookArtifact,
  renderFormulaAwareText,
} from "./excelExtractor.js";
import { extractTabularArtifact, tabularToSearchText } from "./csvIngestor.js";
import {
  ARTIFACT_VERSION,
  buildIngestionReport,
  classifyWorkbookContent,
  type IngestionReport,
  type TabularArtifact,
} from "./ingestionArtifacts.js";
import {
  parseWithLlamaParse,
  shouldUseLlamaParse,
} from "./llamaParseService.js";
import { logger } from "../logger.js";

const CSV_TYPES = new Set(["text/csv", "csv", "application/csv"]);

/**
 * Parse CSV with proper quote/delimiter handling and render as tab-separated
 * rows for secondary chunking / LLM context.
 */
export function extractCsvText(buffer: Buffer): string {
  const records = parseCsv(buffer, {
    bom: true,
    relax_column_count: true,
    skip_empty_lines: true,
  }) as string[][];
  return records
    .map((row, i) => `Row ${i + 1}:\t${row.map((c) => c.trim()).join("\t")}`)
    .join("\n");
}

async function extractTextLocal(buffer: Buffer, fileType: string, filename = ""): Promise<string> {
  if (fileType === "application/pdf" || fileType === "pdf") {
    const { createRequire } = await import("module");
    const require = createRequire(import.meta.url);
    const { PDFParse } = require("pdf-parse") as {
      PDFParse: new (opts: { data: Uint8Array }) => {
        load: () => Promise<void>;
        getText: () => Promise<{ text: string; pages: { text: string; num: number }[]; total: number } | string>;
      };
    };
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    await parser.load();
    const result = await parser.getText();
    return typeof result === "string" ? result : result.text;
  }
  if (CSV_TYPES.has(fileType) || /\.csv$/i.test(filename)) {
    try {
      return extractCsvText(buffer);
    } catch {
      return buffer.toString("utf-8");
    }
  }
  return buffer.toString("utf-8");
}

async function extractText(
  buffer: Buffer,
  fileType: string,
  filename: string,
): Promise<{ text: string; parser: "llamaparse" | "local" }> {
  if (shouldUseLlamaParse(fileType, filename)) {
    try {
      const text = await parseWithLlamaParse(buffer, filename);
      return { text, parser: "llamaparse" };
    } catch (e) {
      logger.warn(
        { detail: (e as Error).message },
        `[Documents] LlamaParse failed for ${filename}, falling back to local extract:`,
      );
    }
  }
  const text = await extractTextLocal(buffer, fileType, filename);
  return { text, parser: "local" };
}

const CHUNK_SIZE = 500;
const CHUNK_OVERLAP = 100;

interface Chunk {
  text: string;
  index: number;
}

function chunkText(text: string): Chunk[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const chunks: Chunk[] = [];
  let start = 0;
  let index = 0;

  while (start < words.length) {
    const end = Math.min(start + CHUNK_SIZE, words.length);
    chunks.push({ text: words.slice(start, end).join(" "), index });
    index++;
    start += CHUNK_SIZE - CHUNK_OVERLAP;
    if (start >= words.length) break;
  }
  return chunks;
}

const DOCUMENT_COLUMNS =
  "document_id, name, original_filename, file_type, document_kind, validation_status, " +
  "file_size_bytes, chunk_count, status, model_schema, workbook_graph, workbook_snapshot, " +
  "tabular_artifact, ingestion_report, artifact_version, qdrant_collection, " +
  "storage_key, storage_backend, " +
  "created_by, workspace_id, created_at, updated_at";

export interface DocumentRecord {
  document_id: string;
  name: string;
  original_filename: string;
  file_type: string;
  document_kind?: "spreadsheet_model" | "tabular_data" | "document_text";
  validation_status?: "processing" | "needs_validation" | "ready" | "error";
  file_size_bytes: number;
  chunk_count: number;
  status: string;
  created_at: string;
  workbook_graph?: Record<string, unknown> | null;
  workbook_snapshot?: Record<string, unknown> | null;
  tabular_artifact?: TabularArtifact | null;
  ingestion_report?: IngestionReport | null;
  artifact_version?: number;
  model_schema?: Record<string, unknown> | null;
  storage_key?: string | null;
  storage_backend?: string | null;
  workspace_id?: string;
}

function isXlsxFile(fileType: string, filename: string): boolean {
  return (
    fileType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    fileType === "xlsx" ||
    /\.xlsx$/i.test(filename)
  );
}

function isCsvFile(fileType: string, filename: string): boolean {
  return CSV_TYPES.has(fileType) || /\.csv$/i.test(filename);
}

/**
 * Process an uploaded document with formula-preserving XLSX / typed CSV paths.
 */
export async function processDocument(
  buffer: Buffer,
  originalFilename: string,
  fileType: string,
  userId: string,
  workspaceId: string,
): Promise<DocumentRecord> {
  const docName = originalFilename.replace(/\.[^.]+$/, "");
  const docId = randomUUID();
  const normalizedFileType = (fileType || "unknown").slice(0, 255);
  const xlsx = isXlsxFile(fileType, originalFilename);
  const csv = isCsvFile(fileType, originalFilename);
  // Provisional kind — XLSX is reclassified by content after structural extract.
  let documentKind: "spreadsheet_model" | "tabular_data" | "document_text" = xlsx
    ? "spreadsheet_model"
    : csv
      ? "tabular_data"
      : "document_text";

  await pool.query(
    `INSERT INTO documents (
       document_id, name, original_filename, file_type, file_size_bytes, status,
       created_by, workspace_id, document_kind, validation_status, file_bytes, artifact_version
     ) VALUES ($1, $2, $3, $4, $5, 'processing', $6, $7, $8, $9, $10, $11)`,
    [
      docId,
      docName,
      originalFilename,
      normalizedFileType,
      buffer.length,
      userId,
      workspaceId,
      documentKind,
      "processing",
      buffer,
      ARTIFACT_VERSION,
    ],
  );

  try {
    let workbookGraph: Record<string, unknown> | null = null;
    let workbookSnapshot: Record<string, unknown> | null = null;
    let tabularArtifact: TabularArtifact | null = null;
    let searchText = "";
    let parser: "llamaparse" | "local" = "local";
    let ingestionReport: IngestionReport;

    if (xlsx) {
      const artifact = await extractWorkbookArtifact(buffer);
      workbookGraph = artifact.graph as unknown as Record<string, unknown>;
      workbookSnapshot = artifact.snapshot as unknown as Record<string, unknown>;
      searchText = renderFormulaAwareText(artifact.graph, artifact.snapshot);
      // Prefer formula-aware local text; LlamaParse strips formulas.
      parser = "local";
      const classified = classifyWorkbookContent(artifact);
      documentKind = classified.document_kind;
      ingestionReport = buildIngestionReport({
        document_kind: documentKind,
        parser,
        workbook: artifact,
        classification_evidence: classified.evidence,
      });
    } else if (csv) {
      try {
        tabularArtifact = extractTabularArtifact(buffer);
        const records = parseCsv(buffer, {
          bom: true,
          relax_column_count: true,
          skip_empty_lines: true,
        }) as string[][];
        searchText = tabularToSearchText(tabularArtifact, records);
      } catch (e) {
        logger.warn({ err: e }, `[Documents] CSV structural parse failed for ${originalFilename}`);
        searchText = buffer.toString("utf-8");
        tabularArtifact = {
          artifact_version: ARTIFACT_VERSION,
          kind: "tabular",
          sheetName: "CSV",
          headers: [],
          columns: [],
          rowCount: 0,
          sampleRows: [],
          delimiter: ",",
          encoding: "utf-8",
          dataOnly: true,
          warnings: [
            {
              code: "parse_fallback",
              message: "CSV structural parse failed; stored raw text for search only",
              detail: (e as Error).message,
            },
            {
              code: "csv_data_only",
              message: "CSV is data-only — no formulas inferred",
            },
          ],
        };
      }
      ingestionReport = buildIngestionReport({
        document_kind: "tabular_data",
        parser: "local",
        tabular: tabularArtifact,
      });
    } else {
      const extracted = await extractText(buffer, fileType, originalFilename);
      searchText = extracted.text;
      parser = extracted.parser;
      ingestionReport = buildIngestionReport({
        document_kind: "document_text",
        parser,
      });
    }

    if (!searchText.trim()) {
      await pool.query(
        `UPDATE documents
         SET status = 'error', validation_status = 'error',
             ingestion_report = $2, updated_at = NOW()
         WHERE document_id = $1`,
        [
          docId,
          JSON.stringify({
            ...ingestionReport,
            executable: false,
            summary: "No text could be extracted",
            warnings: [
              ...ingestionReport.warnings,
              { code: "parse_fallback", message: "No extractable content" },
            ],
          }),
        ],
      );
      throw new Error("No text could be extracted from the document");
    }

    const chunks = chunkText(searchText);
    if (chunks.length === 0) {
      await pool.query(
        "UPDATE documents SET status = 'error', validation_status = 'error', updated_at = NOW() WHERE document_id = $1",
        [docId],
      );
      throw new Error("Document is empty after chunking");
    }

    for (const chunk of chunks) {
      await pool.query(
        `INSERT INTO document_chunks (document_id, chunk_index, text)
         VALUES ($1, $2, $3)
         ON CONFLICT (document_id, chunk_index) DO UPDATE SET text = EXCLUDED.text`,
        [docId, chunk.index, chunk.text],
      );
    }

    // Optional embeddings for hybrid search
    try {
      const { isEmbeddingEnabled, embed } = await import("./embeddingService.js");
      if (isEmbeddingEnabled()) {
        const vectors = await embed(chunks.map((c) => c.text));
        for (let i = 0; i < chunks.length; i++) {
          if (!vectors[i]) continue;
          await pool.query(
            `UPDATE document_chunks SET embedding = $3::jsonb
             WHERE document_id = $1 AND chunk_index = $2`,
            [docId, chunks[i].index, JSON.stringify(vectors[i])],
          );
        }
      }
    } catch (e) {
      logger.warn(
        { detail: (e as Error).message },
        `[Documents] Embedding failed for ${originalFilename} — keyword search still available:`,
      );
    }

    // Optional object storage for original bytes (dual-write; BYTEA retained for fallback)
    try {
      const { storeWorkbookBytes } = await import("./objectStorage.js");
      const stored = await storeWorkbookBytes(workspaceId, docId, buffer, normalizedFileType);
      if (stored) {
        await pool.query(
          `UPDATE documents SET storage_key = $2, storage_backend = $3 WHERE document_id = $1`,
          [docId, stored.storage_key, stored.storage_backend],
        );
      }
    } catch (e) {
      logger.warn({ detail: (e as Error).message }, "[Documents] Object storage write skipped:");
    }

    const validationStatus = documentKind === "spreadsheet_model" ? "needs_validation" : "ready";

    await pool.query(
      `UPDATE documents
       SET chunk_count = $1,
           status = 'ready',
           qdrant_collection = $2,
           workbook_graph = $3,
           workbook_snapshot = $4,
           tabular_artifact = $5,
           ingestion_report = $6,
           artifact_version = $7,
           validation_status = $8,
           document_kind = $9,
           updated_at = NOW()
       WHERE document_id = $10`,
      [
        chunks.length,
        parser === "llamaparse" ? "llamaparse" : "local",
        workbookGraph ? JSON.stringify(workbookGraph) : null,
        workbookSnapshot ? JSON.stringify(workbookSnapshot) : null,
        tabularArtifact ? JSON.stringify(tabularArtifact) : null,
        JSON.stringify(ingestionReport),
        ARTIFACT_VERSION,
        validationStatus,
        documentKind,
        docId,
      ],
    );

    const r = await pool.query(`SELECT ${DOCUMENT_COLUMNS} FROM documents WHERE document_id = $1`, [docId]);
    return r.rows[0];
  } catch (e) {
    await pool.query(
      "UPDATE documents SET status = 'error', validation_status = 'error', updated_at = NOW() WHERE document_id = $1",
      [docId],
    );
    throw e;
  }
}

export async function getDocumentChunksFromDb(documentIds: string[]): Promise<
  {
    document_id: string;
    document_name: string;
    chunk_index: number;
    text: string;
  }[]
> {
  if (documentIds.length === 0) return [];
  const r = await pool.query(
    `SELECT c.document_id, d.name AS document_name, c.chunk_index, c.text
     FROM document_chunks c
     JOIN documents d ON d.document_id = c.document_id
     WHERE c.document_id = ANY($1::uuid[])
     ORDER BY c.document_id, c.chunk_index`,
    [documentIds],
  );
  return r.rows;
}

export async function searchDocumentChunksInDb(
  question: string,
  workspaceId: string,
  topK = 6,
  documentId?: string,
): Promise<
  {
    score: number;
    text: string;
    document_id: string;
    document_name: string;
    chunk_index: number;
  }[]
> {
  const terms = question
    .toLowerCase()
    .split(/\W+/)
    .filter((t) => t.length > 2)
    .slice(0, 8);
  if (terms.length === 0) return [];

  const params: unknown[] = [workspaceId];
  let where = "d.workspace_id = $1";
  if (documentId) {
    params.push(documentId);
    where += ` AND c.document_id = $${params.length}`;
  }

  type Row = {
    document_id: string;
    document_name: string;
    chunk_index: number;
    text: string;
    embedding: number[] | null;
  };

  let rows: Row[] = [];
  try {
    const r = await pool.query(
      `SELECT c.document_id, d.name AS document_name, c.chunk_index, c.text, c.embedding
       FROM document_chunks c
       JOIN documents d ON d.document_id = c.document_id
       WHERE ${where}
       ORDER BY c.created_at DESC
       LIMIT 200`,
      params,
    );
    rows = r.rows as Row[];
  } catch (e) {
    // Migration not applied yet — fall back to keyword-only without embedding column
    const code = (e as { code?: string }).code;
    if (code !== "42703") throw e;
    const r = await pool.query(
      `SELECT c.document_id, d.name AS document_name, c.chunk_index, c.text
       FROM document_chunks c
       JOIN documents d ON d.document_id = c.document_id
       WHERE ${where}
       ORDER BY c.created_at DESC
       LIMIT 200`,
      params,
    );
    rows = (r.rows as Omit<Row, "embedding">[]).map((row) => ({ ...row, embedding: null }));
  }

  const keywordScored = rows.map((row) => {
    const lower = row.text.toLowerCase();
    let hits = 0;
    for (const t of terms) if (lower.includes(t)) hits++;
    return { ...row, keywordScore: hits / terms.length };
  });

  // Hybrid: blend keyword + cosine similarity when embeddings are present
  let queryEmbedding: number[] | null = null;
  try {
    const { isEmbeddingEnabled, embed } = await import("./embeddingService.js");
    const hasAnyEmbedding = keywordScored.some(
      (row) => Array.isArray(row.embedding) && row.embedding.length > 0,
    );
    if (isEmbeddingEnabled() && hasAnyEmbedding) {
      const [vec] = await embed([question]);
      queryEmbedding = vec ?? null;
    }
  } catch {
    queryEmbedding = null;
  }

  const scored = keywordScored.map((row) => {
    let vectorScore = 0;
    if (queryEmbedding && Array.isArray(row.embedding) && row.embedding.length === queryEmbedding.length) {
      vectorScore = cosineSimilarity(queryEmbedding, row.embedding);
    }
    // Prefer hybrid when vectors exist; otherwise keyword only
    const score =
      queryEmbedding && row.embedding
        ? 0.45 * row.keywordScore + 0.55 * Math.max(0, vectorScore)
        : row.keywordScore;
    return {
      document_id: row.document_id,
      document_name: row.document_name,
      chunk_index: row.chunk_index,
      text: row.text,
      score,
    };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Persist a document Q&A turn (optional conversation memory). */
export async function appendDocumentConversationMessage(opts: {
  workspaceId: string;
  userId: string;
  documentId?: string | null;
  conversationId?: string | null;
  question: string;
  answer: string;
  sources?: unknown;
}): Promise<{ conversation_id: string }> {
  let conversationId = opts.conversationId || null;
  if (!conversationId) {
    const title = opts.question.slice(0, 80);
    const created = await pool.query(
      `INSERT INTO document_conversations (workspace_id, document_id, user_id, title)
       VALUES ($1, $2, $3, $4) RETURNING conversation_id`,
      [opts.workspaceId, opts.documentId ?? null, opts.userId, title],
    );
    conversationId = created.rows[0].conversation_id as string;
  }
  await pool.query(
    `INSERT INTO document_conversation_messages (conversation_id, role, content)
     VALUES ($1, 'user', $2)`,
    [conversationId, opts.question],
  );
  await pool.query(
    `INSERT INTO document_conversation_messages (conversation_id, role, content, sources)
     VALUES ($1, 'assistant', $2, $3)`,
    [conversationId, opts.answer, opts.sources ? JSON.stringify(opts.sources) : null],
  );
  await pool.query(
    `UPDATE document_conversations SET updated_at = NOW() WHERE conversation_id = $1`,
    [conversationId],
  );
  return { conversation_id: conversationId };
}

export async function listDocumentConversationMessages(
  conversationId: string,
  workspaceId: string,
): Promise<Array<{ role: string; content: string; sources?: unknown; created_at: string }>> {
  const check = await pool.query(
    `SELECT conversation_id FROM document_conversations
     WHERE conversation_id = $1 AND workspace_id = $2`,
    [conversationId, workspaceId],
  );
  if (check.rows.length === 0) return [];
  const r = await pool.query(
    `SELECT role, content, sources, created_at
     FROM document_conversation_messages
     WHERE conversation_id = $1
     ORDER BY created_at ASC`,
    [conversationId],
  );
  return r.rows;
}

export async function listDocuments(
  userId: string,
  role: Role,
  workspaceId: string,
): Promise<DocumentRecord[]> {
  void userId;
  void role;
  const r = await pool.query(
    `SELECT ${DOCUMENT_COLUMNS} FROM documents WHERE workspace_id = $1 ORDER BY created_at DESC`,
    [workspaceId],
  );
  return r.rows;
}

export async function getDocument(documentId: string): Promise<DocumentRecord | null> {
  const r = await pool.query(`SELECT ${DOCUMENT_COLUMNS} FROM documents WHERE document_id = $1`, [
    documentId,
  ]);
  return r.rows[0] || null;
}

/**
 * Dual-read original workbook/document bytes: storage_key → S3, else BYTEA.
 */
export async function getDocumentOriginalBytes(
  documentId: string,
): Promise<{ bytes: Buffer; contentType: string; filename: string } | null> {
  const r = await pool.query(
    `SELECT document_id, original_filename, file_type, storage_key, file_bytes
     FROM documents WHERE document_id = $1`,
    [documentId],
  );
  const row = r.rows[0];
  if (!row) return null;
  const { loadDocumentBytes } = await import("./objectStorage.js");
  const bytes = await loadDocumentBytes(row);
  if (!bytes) return null;
  return {
    bytes,
    contentType: row.file_type || "application/octet-stream",
    filename: row.original_filename || "document",
  };
}

/** Signed URL for S3 originals; null when using BYTEA-only storage. */
export async function getDocumentSignedUrl(
  documentId: string,
  expiresInSec = 3600,
): Promise<string | null> {
  const r = await pool.query(
    `SELECT storage_key FROM documents WHERE document_id = $1`,
    [documentId],
  );
  const key = r.rows[0]?.storage_key as string | undefined;
  if (!key) return null;
  const { getSignedUrl } = await import("./objectStorage.js");
  return getSignedUrl(key, expiresInSec);
}

export async function deleteDocument(documentId: string): Promise<void> {
  await pool.query("DELETE FROM documents WHERE document_id = $1", [documentId]);
}
