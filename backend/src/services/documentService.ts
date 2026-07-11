/**
 * Document Service
 *
 * Handles document upload, text extraction (LlamaParse + local fallback),
 * chunking, and Postgres storage. Vector DB (Qdrant) has been removed.
 * Supports: PDF, TXT, MD, CSV, XLSX, DOCX
 */

import { pool } from "../db/index.js";
import type { Role } from "../auth/provider.js";
import { randomUUID } from "crypto";
import ExcelJS from "exceljs";
import { parse as parseCsv } from "csv-parse/sync";
import { extractWorkbookGraph } from "./excelExtractor.js";
import {
  parseWithLlamaParse,
  shouldUseLlamaParse,
} from "./llamaParseService.js";
import { logger } from "../logger.js";

const CSV_TYPES = new Set(["text/csv", "csv"]);

/**
 * Parse CSV with proper quote/delimiter handling (was raw buffer.toString,
 * which mangled quoted commas and multi-line cells) and render as
 * tab-separated rows — the same shape the XLSX local extractor produces,
 * so downstream chunking/LLM extraction sees a consistent format.
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

// ── Text extraction ──

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
  if (
    fileType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    fileType === "xlsx"
  ) {
    const workbook = new ExcelJS.Workbook();
    const arrayBuffer = buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength
    ) as ArrayBuffer;
    await workbook.xlsx.load(arrayBuffer);

    const lines: string[] = [];
    workbook.eachSheet((sheet) => {
      lines.push(`Sheet: ${sheet.name}`);
      sheet.eachRow((row, rowNumber) => {
        const values = row.values as unknown[];
        const cells = values
          .slice(1)
          .map((v) => (v == null ? "" : String(v).trim()))
          .filter((v) => v.length > 0);
        if (cells.length > 0) {
          lines.push(`Row ${rowNumber}:\t${cells.join("\t")}`);
        }
      });
      lines.push("");
    });

    return lines.join("\n");
  }
  if (CSV_TYPES.has(fileType) || /\.csv$/i.test(filename)) {
    try {
      return extractCsvText(buffer);
    } catch {
      // Malformed CSV (inconsistent quoting, binary content, etc.) — fall
      // back to raw text rather than failing the whole upload.
      return buffer.toString("utf-8");
    }
  }
  return buffer.toString("utf-8");
}

async function extractText(
  buffer: Buffer,
  fileType: string,
  filename: string
): Promise<{ text: string; parser: "llamaparse" | "local" }> {
  if (shouldUseLlamaParse(fileType, filename)) {
    try {
      const text = await parseWithLlamaParse(buffer, filename);
      return { text, parser: "llamaparse" };
    } catch (e) {
      logger.warn({ detail: (e as Error).message }, `[Documents] LlamaParse failed for ${filename}, falling back to local extract:`);
    }
  }
  const text = await extractTextLocal(buffer, fileType, filename);
  return { text, parser: "local" };
}

// ── Chunking ──

const CHUNK_SIZE = 500;   // ~500 words per chunk
const CHUNK_OVERLAP = 100; // 100 word overlap between chunks

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
    const chunkWords = words.slice(start, end);
    chunks.push({ text: chunkWords.join(" "), index });
    index++;
    start += CHUNK_SIZE - CHUNK_OVERLAP;
    if (start >= words.length) break;
  }

  return chunks;
}

// ── Public API ──

/** Explicit column list — file_bytes is intentionally excluded from reads. */
const DOCUMENT_COLUMNS =
  "document_id, name, original_filename, file_type, document_kind, validation_status, " +
  "file_size_bytes, chunk_count, status, model_schema, workbook_graph, qdrant_collection, " +
  "created_by, workspace_id, created_at, updated_at";

export interface DocumentRecord {
  document_id: string;
  name: string;
  original_filename: string;
  file_type: string;
  document_kind?: "spreadsheet_model" | "document_text";
  validation_status?: "processing" | "needs_validation" | "ready";
  file_size_bytes: number;
  chunk_count: number;
  status: string;
  created_at: string;
}

/**
 * Process an uploaded document: parse (LlamaParse or local), chunk, store in Postgres.
 */
export async function processDocument(
  buffer: Buffer,
  originalFilename: string,
  fileType: string,
  userId: string,
  workspaceId: string
): Promise<DocumentRecord> {
  const docName = originalFilename.replace(/\.[^.]+$/, "");
  const docId = randomUUID();
  const normalizedFileType = (fileType || "unknown").slice(0, 255);
  const isXlsx =
    fileType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    fileType === "xlsx" ||
    /\.xlsx$/i.test(originalFilename);
  const documentKind = isXlsx ? "spreadsheet_model" : "document_text";

  // Original bytes are persisted so spreadsheet models can be re-processed
  // (cell-level simulation needs the full workbook, not just extracted text).
  await pool.query(
    `INSERT INTO documents (document_id, name, original_filename, file_type, file_size_bytes, status, created_by, workspace_id, document_kind, validation_status, file_bytes)
     VALUES ($1, $2, $3, $4, $5, 'processing', $6, $7, $8, $9, $10)`,
    [docId, docName, originalFilename, normalizedFileType, buffer.length, userId, workspaceId, documentKind, "processing", buffer]
  );

  try {
    let workbookGraph: Record<string, unknown> | null = null;
    if (isXlsx) {
      workbookGraph = await extractWorkbookGraph(buffer) as unknown as Record<string, unknown>;
    }

    const { text, parser } = await extractText(buffer, fileType, originalFilename);
    if (!text.trim()) {
      await pool.query("UPDATE documents SET status = 'error', updated_at = NOW() WHERE document_id = $1", [docId]);
      throw new Error("No text could be extracted from the document");
    }

    const chunks = chunkText(text);
    if (chunks.length === 0) {
      await pool.query("UPDATE documents SET status = 'error', updated_at = NOW() WHERE document_id = $1", [docId]);
      throw new Error("Document is empty after chunking");
    }

    for (const chunk of chunks) {
      await pool.query(
        `INSERT INTO document_chunks (document_id, chunk_index, text)
         VALUES ($1, $2, $3)
         ON CONFLICT (document_id, chunk_index) DO UPDATE SET text = EXCLUDED.text`,
        [docId, chunk.index, chunk.text]
      );
    }

    await pool.query(
      `UPDATE documents
       SET chunk_count = $1,
           status = 'ready',
           qdrant_collection = $2,
           workbook_graph = $3,
           updated_at = NOW()
       WHERE document_id = $4`,
      [
        chunks.length,
        parser === "llamaparse" ? "llamaparse" : "local",
        workbookGraph ? JSON.stringify(workbookGraph) : null,
        docId,
      ]
    );

    const r = await pool.query(`SELECT ${DOCUMENT_COLUMNS} FROM documents WHERE document_id = $1`, [docId]);
    return r.rows[0];
  } catch (e) {
    await pool.query("UPDATE documents SET status = 'error', updated_at = NOW() WHERE document_id = $1", [docId]);
    throw e;
  }
}

/** Load chunks from Postgres for context / RAG fallback. */
export async function getDocumentChunksFromDb(documentIds: string[]): Promise<{
  document_id: string;
  document_name: string;
  chunk_index: number;
  text: string;
}[]> {
  if (documentIds.length === 0) return [];
  const r = await pool.query(
    `SELECT c.document_id, d.name AS document_name, c.chunk_index, c.text
     FROM document_chunks c
     JOIN documents d ON d.document_id = c.document_id
     WHERE c.document_id = ANY($1::uuid[])
     ORDER BY c.document_id, c.chunk_index`,
    [documentIds]
  );
  return r.rows;
}

/**
 * Simple keyword search over stored document chunks (Postgres).
 */
export async function searchDocumentChunksInDb(
  question: string,
  workspaceId: string,
  topK = 6,
  documentId?: string
): Promise<{
  score: number;
  text: string;
  document_id: string;
  document_name: string;
  chunk_index: number;
}[]> {
  const terms = question
    .toLowerCase()
    .split(/\W+/)
    .filter((t) => t.length > 2)
    .slice(0, 8);
  if (terms.length === 0) return [];

  // Always scope retrieval to the workspace — previously the all-documents
  // branch had no filter at all and searched every user's chunks.
  const params: unknown[] = [workspaceId];
  let where = "d.workspace_id = $1";
  if (documentId) {
    params.push(documentId);
    where += ` AND c.document_id = $${params.length}`;
  }

  const r = await pool.query(
    `SELECT c.document_id, d.name AS document_name, c.chunk_index, c.text
     FROM document_chunks c
     JOIN documents d ON d.document_id = c.document_id
     WHERE ${where}
     ORDER BY c.created_at DESC
     LIMIT 200`,
    params
  );

  const scored = r.rows.map((row: { document_id: string; document_name: string; chunk_index: number; text: string }) => {
    const lower = row.text.toLowerCase();
    let hits = 0;
    for (const t of terms) if (lower.includes(t)) hits++;
    return { ...row, score: hits / terms.length };
  });

  return scored
    .filter((s: { score: number }) => s.score > 0)
    .sort((a: { score: number }, b: { score: number }) => b.score - a.score)
    .slice(0, topK);
}

/**
 * List documents in the active workspace.
 * Workspaces are single-owner, so the workspace filter also enforces
 * ownership; admins browsing other users' documents go through explicit ids.
 */
export async function listDocuments(userId: string, role: Role, workspaceId: string): Promise<DocumentRecord[]> {
  const r = await pool.query(
    `SELECT ${DOCUMENT_COLUMNS} FROM documents WHERE workspace_id = $1 ORDER BY created_at DESC`,
    [workspaceId]
  );
  return r.rows;
}

/**
 * Get a single document by ID.
 */
export async function getDocument(documentId: string): Promise<DocumentRecord | null> {
  const r = await pool.query(`SELECT ${DOCUMENT_COLUMNS} FROM documents WHERE document_id = $1`, [documentId]);
  return r.rows[0] || null;
}

/**
 * Delete a document (chunks cascade via FK).
 */
export async function deleteDocument(documentId: string): Promise<void> {
  await pool.query("DELETE FROM documents WHERE document_id = $1", [documentId]);
}
