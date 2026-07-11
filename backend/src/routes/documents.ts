/**
 * Document routes — upload, list, query (RAG), delete
 */

import { Router } from "express";
import multer from "multer";
import { processDocument, listDocuments, getDocument, deleteDocument } from "../services/documentService.js";
import { queryDocument } from "../services/ragService.js";
import { isLlamaParseConfigured, testLlamaParseConnection } from "../services/llamaParseService.js";
import { requireRole } from "../middleware/rbac.js";
import { assertCanReadDocument } from "../services/authzService.js";
import { logger } from "../logger.js";

export const documentsRouter = Router();

function authzError(e: unknown) {
  return (e as { status?: number }).status;
}

// Multer config: store in memory, max 20MB
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
  fileFilter: (_req, file, cb) => {
    const allowed = [
      "application/pdf",
      "text/plain",
      "text/markdown",
      "text/csv",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ];
    const extAllowed = /\.(pdf|txt|md|csv|docx|xlsx)$/i;
    if (allowed.includes(file.mimetype) || extAllowed.test(file.originalname)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${file.mimetype}. Allowed: PDF, TXT, MD, CSV, XLSX`));
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

    const userId = req.user!.userId;

    const doc = await processDocument(
      req.file.buffer,
      req.file.originalname,
      req.file.mimetype || req.file.originalname.split(".").pop() || "unknown",
      userId
    );

    return res.status(201).json({ ...doc, context_hint: "Document uploaded. Click 'Build Context' to analyze all documents and create/update your company model." });
  } catch (e) {
    logger.error({ err: e }, "Document upload failed:");
    const msg = (e as Error).message;
    if (msg.includes("Unsupported file type")) return res.status(400).json({ error: msg });
    return res.status(500).json({ error: "Document processing failed: " + msg });
  }
});

// ── List documents ──
documentsRouter.get("/", async (req, res) => {
  try {
    const docs = await listDocuments(req.user!.userId, req.user!.role);
    return res.json({ documents: docs });
  } catch (e) {
    logger.error({ err: e }, "Request failed");
    return res.status(500).json({ error: "Failed to list documents" });
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
    if (doc.status !== "ready") {
      return res.status(400).json({ error: `Document is still ${doc.status}. Please wait.` });
    }

    const result = await queryDocument(question, req.params.id);
    return res.json(result);
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

    const result = await queryDocument(question);
    return res.json(result);
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
