/**
 * Document Service
 *
 * Handles document upload, text extraction, chunking, embedding, and storage.
 * Supports: PDF, TXT, MD, CSV
 */

import { pool } from "../db/index.js";
import { embed } from "./embeddingService.js";
import { upsertChunks, deleteDocumentChunks, type ChunkPoint } from "./qdrantService.js";
import { randomUUID } from "crypto";

// ── Text extraction ──

async function extractText(buffer: Buffer, fileType: string): Promise<string> {
  if (fileType === "application/pdf" || fileType === "pdf") {
    // pdf-parse v2+ uses a class-based API: new PDFParse({ data }) → load() → getText()
    // getText() returns { pages, text, total } — we need the .text property
    const { createRequire } = await import("module");
    const require = createRequire(import.meta.url);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { PDFParse } = require("pdf-parse") as {
      PDFParse: new (opts: { data: Uint8Array }) => {
        load: () => Promise<void>;
        getText: () => Promise<{ text: string; pages: { text: string; num: number }[]; total: number } | string>;
      };
    };
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    await parser.load();
    const result = await parser.getText();
    // Handle both string and object return types
    return typeof result === "string" ? result : result.text;
  }
  // Plain text, markdown, CSV → use buffer as-is
  return buffer.toString("utf-8");
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

// ── DB table auto-creation ──

let tableEnsured = false;
async function ensureTable(): Promise<void> {
  if (tableEnsured) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS documents (
      document_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(255) NOT NULL,
      original_filename VARCHAR(500) NOT NULL,
      file_type VARCHAR(50) NOT NULL,
      file_size_bytes INTEGER,
      chunk_count INTEGER DEFAULT 0,
      status VARCHAR(50) DEFAULT 'processing',
      qdrant_collection VARCHAR(255),
      created_by UUID REFERENCES users(user_id),
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  tableEnsured = true;
}

// ── Public API ──

export interface DocumentRecord {
  document_id: string;
  name: string;
  original_filename: string;
  file_type: string;
  file_size_bytes: number;
  chunk_count: number;
  status: string;
  created_at: string;
}

/**
 * Process an uploaded document: extract text, chunk, embed, store in Qdrant.
 */
export async function processDocument(
  buffer: Buffer,
  originalFilename: string,
  fileType: string,
  userId: string
): Promise<DocumentRecord> {
  await ensureTable();

  const docName = originalFilename.replace(/\.[^.]+$/, "");
  const docId = randomUUID();

  // Insert document record (status: processing)
  await pool.query(
    `INSERT INTO documents (document_id, name, original_filename, file_type, file_size_bytes, status, created_by)
     VALUES ($1, $2, $3, $4, $5, 'processing', $6)`,
    [docId, docName, originalFilename, fileType, buffer.length, userId]
  );

  try {
    // 1. Extract text
    const text = await extractText(buffer, fileType);
    if (!text.trim()) {
      await pool.query("UPDATE documents SET status = 'error', updated_at = NOW() WHERE document_id = $1", [docId]);
      throw new Error("No text could be extracted from the document");
    }

    // 2. Chunk
    const chunks = chunkText(text);
    if (chunks.length === 0) {
      await pool.query("UPDATE documents SET status = 'error', updated_at = NOW() WHERE document_id = $1", [docId]);
      throw new Error("Document is empty after chunking");
    }

    // 3. Embed
    const vectors = await embed(chunks.map((c) => c.text));

    // 4. Store in Qdrant
    const points: ChunkPoint[] = chunks.map((chunk, i) => ({
      id: randomUUID(), // Qdrant expects UUID or unsigned int as point IDs
      vector: vectors[i],
      payload: {
        document_id: docId,
        document_name: docName,
        chunk_index: chunk.index,
        text: chunk.text,
      },
    }));

    await upsertChunks(points);

    // 5. Update document record
    await pool.query(
      "UPDATE documents SET chunk_count = $1, status = 'ready', qdrant_collection = $2, updated_at = NOW() WHERE document_id = $3",
      [chunks.length, process.env.QDRANT_COLLECTION || "scenario_documents", docId]
    );

    const r = await pool.query("SELECT * FROM documents WHERE document_id = $1", [docId]);
    return r.rows[0];
  } catch (e) {
    await pool.query("UPDATE documents SET status = 'error', updated_at = NOW() WHERE document_id = $1", [docId]);
    throw e;
  }
}

/**
 * List all documents.
 */
export async function listDocuments(): Promise<DocumentRecord[]> {
  await ensureTable();
  const r = await pool.query("SELECT * FROM documents ORDER BY created_at DESC");
  return r.rows;
}

/**
 * Get a single document by ID.
 */
export async function getDocument(documentId: string): Promise<DocumentRecord | null> {
  await ensureTable();
  const r = await pool.query("SELECT * FROM documents WHERE document_id = $1", [documentId]);
  return r.rows[0] || null;
}

/**
 * Delete a document and its chunks from Qdrant.
 */
export async function deleteDocument(documentId: string): Promise<void> {
  await ensureTable();
  await deleteDocumentChunks(documentId);
  await pool.query("DELETE FROM documents WHERE document_id = $1", [documentId]);
}
