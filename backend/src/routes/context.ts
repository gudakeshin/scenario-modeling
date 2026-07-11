/**
 * Context API routes — build, get, edit, delete company context and model schema.
 */

import { Router } from "express";
import {
  getActiveContext,
  getActiveModel,
  updateContext,
  updateModel,
  deleteContext,
} from "../services/contextEngine.js";
import { buildContextForUser } from "../services/contextEngineFactory.js";
import { pool } from "../db/index.js";
import { requireRole } from "../middleware/rbac.js";
import { logger } from "../logger.js";

export const contextRouter = Router();

// ── Build context from uploaded documents ──
contextRouter.post("/build", requireRole("analyst"), async (req, res) => {
  try {
    const userId = req.user!.userId;
    const ctx = await buildContextForUser(userId);
    return res.status(201).json(ctx);
  } catch (e) {
    logger.error({ err: e }, "[Context] Build failed:");
    const msg = (e as Error).message;
    if (msg.includes("No processed documents")) return res.status(400).json({ error: msg });
    if (msg.includes("ANTHROPIC_API_KEY")) return res.status(503).json({ error: msg });
    return res.status(500).json({ error: "Context build failed: " + msg });
  }
});

// ── Get current context ──
contextRouter.get("/", async (req, res) => {
  try {
    const userId = req.user!.userId;
    const ctx = await getActiveContext(userId);
    if (!ctx) return res.json({ context: null, message: "No context found. Upload documents and build context." });
    const docRes = await pool.query(
      `SELECT document_id, validation_status
       FROM documents
       WHERE created_by = $1
         AND status = 'ready'
         AND document_kind = 'spreadsheet_model'
       ORDER BY created_at DESC
       LIMIT 1`,
      [userId],
    );
    return res.json({
      context: ctx,
      model_intelligence: docRes.rows.length > 0
        ? {
            document_id: docRes.rows[0].document_id,
            validation_status: docRes.rows[0].validation_status,
          }
        : null,
    });
  } catch (e) {
    logger.error({ err: e }, "Request failed");
    return res.status(500).json({ error: "Failed to get context" });
  }
});

// ── Update context data ──
contextRouter.put("/", requireRole("analyst"), async (req, res) => {
  try {
    const userId = req.user!.userId;
    const existing = await getActiveContext(userId);
    if (!existing) return res.status(404).json({ error: "No active context to update" });
    const updated = await updateContext(existing.context_id, req.body);
    return res.json(updated);
  } catch (e) {
    logger.error({ err: e }, "Request failed");
    return res.status(500).json({ error: "Failed to update context" });
  }
});

// ── Delete context (reset) ──
contextRouter.delete("/", requireRole("analyst"), async (req, res) => {
  try {
    const userId = req.user!.userId;
    await deleteContext(userId);
    return res.json({ deleted: true });
  } catch (e) {
    logger.error({ err: e }, "Request failed");
    return res.status(500).json({ error: "Failed to delete context" });
  }
});

// ── Get active model ──
contextRouter.get("/model", async (req, res) => {
  try {
    const userId = req.user!.userId;
    const model = await getActiveModel(userId);
    if (!model) return res.json({ model: null, message: "No model found. Build context from documents first." });
    return res.json({ model });
  } catch (e) {
    logger.error({ err: e }, "Request failed");
    return res.status(500).json({ error: "Failed to get model" });
  }
});

// ── Update model definition ──
contextRouter.put("/model", requireRole("analyst"), async (req, res) => {
  try {
    const userId = req.user!.userId;
    const model = await getActiveModel(userId);
    if (!model) return res.status(404).json({ error: "No active model to update" });
    if (!req.body.model_definition) return res.status(400).json({ error: "model_definition is required" });
    await updateModel(model.model_id, req.body.model_definition);
    const updated = await getActiveModel(userId);
    return res.json({ model: updated });
  } catch (e) {
    logger.error({ err: e }, "Request failed");
    return res.status(500).json({ error: "Failed to update model" });
  }
});

// ── Check onboarding status (context + model existence) ──
contextRouter.get("/status", async (req, res) => {
  try {
    const userId = req.user!.userId;
    const ctx = await getActiveContext(userId);
    const model = await getActiveModel(userId);
    const ctxData = ctx?.context_data as Record<string, unknown> | undefined;
    const latestSpreadsheet = await pool.query(
      `SELECT validation_status
       FROM documents
       WHERE created_by = $1
         AND status = 'ready'
         AND document_kind = 'spreadsheet_model'
       ORDER BY created_at DESC
       LIMIT 1`,
      [userId],
    );
    return res.json({
      has_context: !!ctx,
      has_model: !!model,
      company_name: ctx?.company_name || null,
      industry: ctx?.industry || null,
      model_name: model?.name || null,
      currency: (ctxData?.currency as string) || "USD",
      currency_unit: (ctxData?.currency_unit as string) || "",
      validation_status: latestSpreadsheet.rows[0]?.validation_status || null,
      ready: !!(ctx && model),
    });
  } catch (e) {
    logger.error({ err: e }, "Request failed");
    return res.status(500).json({ error: "Failed to check status" });
  }
});

// ── Validate latest spreadsheet model schema (analyst gate) ──
contextRouter.post("/model/validate", requireRole("analyst"), async (req, res) => {
  try {
    const userId = req.user!.userId;
    const targetDocId = req.body?.document_id as string | undefined;

    const docRes = targetDocId
      ? await pool.query(
          `SELECT document_id FROM documents
           WHERE document_id = $1 AND created_by = $2 AND document_kind = 'spreadsheet_model'`,
          [targetDocId, userId],
        )
      : await pool.query(
          `SELECT document_id FROM documents
           WHERE created_by = $1 AND document_kind = 'spreadsheet_model' AND model_schema IS NOT NULL
           ORDER BY created_at DESC
           LIMIT 1`,
          [userId],
        );
    if (docRes.rows.length === 0) {
      return res.status(404).json({ error: "No spreadsheet model found for validation" });
    }
    const documentId = docRes.rows[0].document_id as string;
    await pool.query(
      `UPDATE documents
       SET validation_status = 'ready',
           updated_at = NOW()
       WHERE document_id = $1`,
      [documentId],
    );

    const existing = await getActiveContext(userId);
    if (existing) {
      await updateContext(existing.context_id, { validation_status: "ready" } as never);
    }

    return res.json({ validated: true, document_id: documentId, validation_status: "ready" });
  } catch (e) {
    logger.error({ err: e }, "Request failed");
    return res.status(500).json({ error: "Failed to validate model schema" });
  }
});
