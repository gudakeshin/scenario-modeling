/**
 * Document routes — upload, list, query (RAG), delete
 */

import { Router } from "express";
import multer from "multer";
import { processDocument, listDocuments, getDocument, deleteDocument } from "../services/documentService.js";
import { queryDocument } from "../services/ragService.js";
import { testConnection } from "../services/qdrantService.js";
import { resolveUserId } from "../db/index.js";

export const documentsRouter = Router();

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
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ];
    const extAllowed = /\.(pdf|txt|md|csv|docx)$/i;
    if (allowed.includes(file.mimetype) || extAllowed.test(file.originalname)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${file.mimetype}. Allowed: PDF, TXT, MD, CSV`));
    }
  },
});

// ── Upload document ──
// Wrap multer to catch fileFilter errors and return JSON instead of HTML
documentsRouter.post("/upload", (req, res, next) => {
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

    const userId = await resolveUserId(req.headers["x-user-id"] as string | undefined);

    const doc = await processDocument(
      req.file.buffer,
      req.file.originalname,
      req.file.mimetype || req.file.originalname.split(".").pop() || "unknown",
      userId
    );

    return res.status(201).json({ ...doc, context_hint: "Document uploaded. Click 'Build Context' to analyze all documents and create/update your company model." });
  } catch (e) {
    console.error("Document upload failed:", e);
    const msg = (e as Error).message;
    if (msg.includes("Unsupported file type")) return res.status(400).json({ error: msg });
    return res.status(500).json({ error: "Document processing failed: " + msg });
  }
});

// ── List documents ──
documentsRouter.get("/", async (_req, res) => {
  try {
    const docs = await listDocuments();
    return res.json({ documents: docs });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Failed to list documents" });
  }
});

// ── Get single document ──
documentsRouter.get("/:id", async (req, res) => {
  try {
    const doc = await getDocument(req.params.id);
    if (!doc) return res.status(404).json({ error: "Document not found" });
    return res.json(doc);
  } catch (e) {
    console.error(e);
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

    const doc = await getDocument(req.params.id);
    if (!doc) return res.status(404).json({ error: "Document not found" });
    if (doc.status !== "ready") {
      return res.status(400).json({ error: `Document is still ${doc.status}. Please wait.` });
    }

    const result = await queryDocument(question, req.params.id);
    return res.json(result);
  } catch (e) {
    console.error(e);
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
    console.error(e);
    return res.status(500).json({ error: "Query failed: " + (e as Error).message });
  }
});

// ── Delete document ──
documentsRouter.delete("/:id", async (req, res) => {
  try {
    const doc = await getDocument(req.params.id);
    if (!doc) return res.status(404).json({ error: "Document not found" });
    await deleteDocument(req.params.id);
    return res.json({ deleted: true, document_id: req.params.id });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Failed to delete document" });
  }
});

// ── Health check for Qdrant connection ──
documentsRouter.get("/health/qdrant", async (_req, res) => {
  const ok = await testConnection();
  return res.json({ qdrant: ok ? "connected" : "disconnected", url: process.env.QDRANT_URL || "http://localhost:6333" });
});
