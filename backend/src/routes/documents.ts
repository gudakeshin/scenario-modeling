/**
 * Document routes — upload, list, query (RAG), delete
 */

import { Router } from "express";
import multer from "multer";
import { tmpdir } from "node:os";
import { readFile, unlink } from "node:fs/promises";
import { processDocument, createQueuedDocument, listDocuments, getDocument, deleteDocument, appendDocumentConversationMessage, listDocumentConversationMessages, getDocumentSignedUrl, getDocumentOriginalBytes } from "../services/documentService.js";
import { queryDocument } from "../services/ragService.js";
import { isLlamaParseConfigured, testLlamaParseConnection } from "../services/llamaParseService.js";
import { requireRole } from "../middleware/rbac.js";
import { assertCanReadDocument } from "../services/authzService.js";
import { scopeOf } from "../middleware/workspace.js";
import { logger } from "../logger.js";
import { isEmbeddingEnabled } from "../services/embeddingService.js";
import { config } from "../config.js";
import {
  enqueueDocumentIngestion,
  isAsyncIngestionEnabled,
} from "../queue/ingestionQueue.js";
import { scanBuffer } from "../services/virusScanService.js";

export const documentsRouter = Router();

function authzError(e: unknown) {
  return (e as { status?: number }).status;
}

// Disk-backed upload avoids retaining the entire request body in the API heap.
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, tmpdir()),
    filename: (_req, file, cb) =>
      cb(null, `scenario-model-${Date.now()}-${Math.random().toString(36).slice(2)}-${file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_")}`),
  }),
  limits: { fileSize: config.DOCUMENT_UPLOAD_MAX_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/\.(xls|xlsb)$/i.test(file.originalname)) {
      cb(new Error("Legacy .xls/.xlsb is not supported. Please save as .xlsx and re-upload."));
      return;
    }
    const allowed = [
      "application/pdf",
      "text/plain",
      "text/markdown",
      "text/csv",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.ms-excel.sheet.macroEnabled.12",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ];
    const extAllowed = /\.(pdf|txt|md|csv|docx|xlsx|xlsm)$/i;
    if (allowed.includes(file.mimetype) || extAllowed.test(file.originalname)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${file.mimetype}. Allowed: PDF, TXT, MD, CSV, DOCX, XLSX, XLSM`));
    }
  },
});

// ── Upload document ──
// Wrap multer to catch fileFilter errors and return JSON instead of HTML
documentsRouter.post("/upload", requireRole("analyst"), (req, res, next) => {
  upload.single("file")(req, res, (err) => {
    if (err) {
      return res.status(400).json({ error: err.message || "File upload error" });
    }
    next();
  });
}, async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const scope = scopeOf(req);
    const file = req.file;
    const buffer = await readFile(file.path);
    const fileType = file.mimetype || file.originalname.split(".").pop() || "unknown";

    // Scan before any Postgres/S3 persistence so infected bytes never land.
    const scan = await scanBuffer(buffer);
    if (scan.status === "infected") {
      return res.status(422).json({
        error: "Upload rejected because malware was detected",
        signature: scan.signature,
      });
    }

    if (isAsyncIngestionEnabled()) {
      const doc = await createQueuedDocument(
        buffer,
        file.originalname,
        fileType,
        scope.userId,
        scope.workspaceId,
      );
      await enqueueDocumentIngestion(doc.document_id);
      return res.status(202).json({
        ...doc,
        context_hint: "Document queued for ingestion. Progress updates automatically.",
      });
    }

    const doc = await processDocument(
      buffer,
      file.originalname,
      fileType,
      scope.userId,
      scope.workspaceId,
    );
    return res.status(201).json({
      ...doc,
      context_hint: "Document uploaded. Click 'Build Context' to analyze all documents and create/update your company model.",
    });
  } catch (e) {
    logger.error({ err: e }, "Document upload failed:");
    const msg = (e as Error).message;
    if (msg.includes("Unsupported file type")) return res.status(400).json({ error: msg });
    return res.status(500).json({ error: "Document processing failed: " + msg });
  } finally {
    if (req.file?.path) await unlink(req.file.path).catch(() => undefined);
  }
});

// ── List documents ──
documentsRouter.get("/", async (req, res) => {
  try {
    const limit = Number(req.query.limit ?? 50);
    const offset = Number(req.query.offset ?? 0);
    const result = await listDocuments(
      req.user!.userId,
      req.user!.role,
      req.workspace!.workspaceId,
      { limit, offset },
    );
    return res.json(result);
  } catch (e) {
    logger.error({ err: e }, "Request failed");
    return res.status(500).json({ error: "Failed to list documents" });
  }
});

// ── Document conversation history (before /:id) ──
documentsRouter.get("/conversations/:conversationId/messages", async (req, res) => {
  try {
    const messages = await listDocumentConversationMessages(
      req.params.conversationId,
      req.workspace!.workspaceId,
    );
    return res.json({ conversation_id: req.params.conversationId, messages });
  } catch (e) {
    logger.error({ err: e }, "Request failed");
    return res.status(500).json({ error: "Failed to load conversation" });
  }
});

// ── Get single document ──
documentsRouter.get("/:id", async (req, res) => {
  try {
    await assertCanReadDocument(req.user!.userId, req.user!.role, req.params.id);
    const doc = await getDocument(req.params.id);
    if (!doc) return res.status(404).json({ error: "Document not found" });
    return res.json(doc);
  } catch (e) {
    const status = authzError(e);
    if (status) return res.status(status).json({ error: (e as Error).message });
    logger.error({ err: e }, "Request failed");
    return res.status(500).json({ error: "Failed to get document" });
  }
});

// ── Signed URL for original (S3); 404 when BYTEA-only ──
documentsRouter.get("/:id/signed-url", async (req, res) => {
  try {
    await assertCanReadDocument(req.user!.userId, req.user!.role, req.params.id);
    const url = await getDocumentSignedUrl(req.params.id);
    if (!url) {
      return res.status(404).json({
        error: "Signed URL unavailable — use /original for encrypted or Postgres-backed documents",
        code: "NO_OBJECT_STORAGE",
      });
    }
    return res.json({ url, expires_in: 3600 });
  } catch (e) {
    const status = authzError(e);
    if (status) return res.status(status).json({ error: (e as Error).message });
    logger.error({ err: e }, "Request failed");
    return res.status(500).json({ error: "Failed to get signed URL" });
  }
});

// ── Download original bytes (dual-read S3 → BYTEA) ──
documentsRouter.get("/:id/original", async (req, res) => {
  try {
    await assertCanReadDocument(req.user!.userId, req.user!.role, req.params.id);
    const original = await getDocumentOriginalBytes(req.params.id);
    if (!original) return res.status(404).json({ error: "Original bytes not found" });
    res.setHeader("Content-Type", original.contentType);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${original.filename.replace(/"/g, "")}"`,
    );
    return res.send(original.bytes);
  } catch (e) {
    const status = authzError(e);
    if (status) return res.status(status).json({ error: (e as Error).message });
    logger.error({ err: e }, "Request failed");
    return res.status(500).json({ error: "Failed to download original" });
  }
});

// ── Query document (RAG) ──
documentsRouter.post("/:id/query", async (req, res) => {
  try {
    const { question } = req.body;
    if (!question || typeof question !== "string") {
      return res.status(400).json({ error: "question is required" });
    }

    await assertCanReadDocument(req.user!.userId, req.user!.role, req.params.id);
    const doc = await getDocument(req.params.id);
    if (!doc) return res.status(404).json({ error: "Document not found" });
    // Strict isolation: documents are only queryable from their own workspace.
    if ((doc as { workspace_id?: string }).workspace_id !== req.workspace!.workspaceId) {
      return res.status(404).json({ error: "Document not found" });
    }
    if (doc.status !== "ready") {
      return res.status(400).json({ error: `Document is still ${doc.status}. Please wait.` });
    }

    const result = await queryDocument(question, req.workspace!.workspaceId, req.params.id, {
      conversationId: req.body?.conversation_id,
    });
    let conversation_id: string | undefined;
    if (req.body?.persist !== false) {
      try {
        const saved = await appendDocumentConversationMessage({
          workspaceId: req.workspace!.workspaceId,
          userId: req.user!.userId,
          documentId: req.params.id,
          conversationId: req.body?.conversation_id,
          question,
          answer: result.answer,
          sources: result.sources,
        });
        conversation_id = saved.conversation_id;
      } catch (e) {
        logger.warn({ detail: (e as Error).message }, "[Documents] Failed to persist conversation:");
      }
    }
    return res.json({ ...result, conversation_id, retrieval: isEmbeddingEnabled() ? "hybrid" : "keyword" });
  } catch (e) {
    const status = authzError(e);
    if (status) return res.status(status).json({ error: (e as Error).message });
    logger.error({ err: e }, "Request failed");
    return res.status(500).json({ error: "Query failed: " + (e as Error).message });
  }
});

// ── Query all documents (RAG across all) ──
documentsRouter.post("/query", async (req, res) => {
  try {
    const { question } = req.body;
    if (!question || typeof question !== "string") {
      return res.status(400).json({ error: "question is required" });
    }

    const result = await queryDocument(question, req.workspace!.workspaceId, undefined, {
      conversationId: req.body?.conversation_id,
    });
    let conversation_id: string | undefined;
    if (req.body?.persist !== false) {
      try {
        const saved = await appendDocumentConversationMessage({
          workspaceId: req.workspace!.workspaceId,
          userId: req.user!.userId,
          documentId: null,
          conversationId: req.body?.conversation_id,
          question,
          answer: result.answer,
          sources: result.sources,
        });
        conversation_id = saved.conversation_id;
      } catch (e) {
        logger.warn({ detail: (e as Error).message }, "[Documents] Failed to persist conversation:");
      }
    }
    return res.json({ ...result, conversation_id, retrieval: isEmbeddingEnabled() ? "hybrid" : "keyword" });
  } catch (e) {
    logger.error({ err: e }, "Request failed");
    return res.status(500).json({ error: "Query failed: " + (e as Error).message });
  }
});

// ── Delete document ──
documentsRouter.delete("/:id", async (req, res) => {
  try {
    await assertCanReadDocument(req.user!.userId, req.user!.role, req.params.id);
    const doc = await getDocument(req.params.id);
    if (!doc) return res.status(404).json({ error: "Document not found" });
    await deleteDocument(req.params.id);
    return res.json({ deleted: true, document_id: req.params.id });
  } catch (e) {
    const status = authzError(e);
    if (status) return res.status(status).json({ error: (e as Error).message });
    logger.error({ err: e }, "Request failed");
    return res.status(500).json({ error: "Failed to delete document" });
  }
});

// ── Health check for document parsing (LlamaParse) ──
documentsRouter.get("/health/parser", async (_req, res) => {
  const configured = isLlamaParseConfigured();
  const ok = await testLlamaParseConnection();
  return res.json({
    parser: "llamaparse",
    configured: ok,
    status: configured ? "ready" : "missing_api_key",
    fallback: "local",
  });
});

/** @deprecated use /health/parser */
documentsRouter.get("/health/qdrant", async (_req, res) => {
  const configured = isLlamaParseConfigured();
  return res.json({
    qdrant: "removed",
    parser: "llamaparse",
    configured,
    message: "Qdrant has been replaced by LlamaParse + Postgres chunk storage",
  });
});
