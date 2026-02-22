/**
 * Context API routes — build, get, edit, delete company context and model schema.
 */

import { Router } from "express";
import {
  buildContext,
  getActiveContext,
  getActiveModel,
  updateContext,
  updateModel,
  deleteContext,
} from "../services/contextEngine.js";
import { resolveUserId } from "../db/index.js";

export const contextRouter = Router();

// ── Build context from uploaded documents ──
contextRouter.post("/build", async (req, res) => {
  try {
    const userId = req.headers["x-user-id"] as string | undefined;
    const ctx = await buildContext(userId);
    return res.status(201).json(ctx);
  } catch (e) {
    console.error("[Context] Build failed:", e);
    const msg = (e as Error).message;
    if (msg.includes("No processed documents")) return res.status(400).json({ error: msg });
    if (msg.includes("ANTHROPIC_API_KEY")) return res.status(503).json({ error: msg });
    return res.status(500).json({ error: "Context build failed: " + msg });
  }
});

// ── Get current context ──
contextRouter.get("/", async (req, res) => {
  try {
    const userId = req.headers["x-user-id"] as string | undefined;
    const ctx = await getActiveContext(userId);
    if (!ctx) return res.json({ context: null, message: "No context found. Upload documents and build context." });
    return res.json({ context: ctx });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Failed to get context" });
  }
});

// ── Update context data ──
contextRouter.put("/", async (req, res) => {
  try {
    const userId = req.headers["x-user-id"] as string | undefined;
    const existing = await getActiveContext(userId);
    if (!existing) return res.status(404).json({ error: "No active context to update" });
    const updated = await updateContext(existing.context_id, req.body);
    return res.json(updated);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Failed to update context" });
  }
});

// ── Delete context (reset) ──
contextRouter.delete("/", async (req, res) => {
  try {
    const userId = req.headers["x-user-id"] as string | undefined;
    await deleteContext(userId);
    return res.json({ deleted: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Failed to delete context" });
  }
});

// ── Get active model ──
contextRouter.get("/model", async (req, res) => {
  try {
    const userId = req.headers["x-user-id"] as string | undefined;
    const model = await getActiveModel(userId);
    if (!model) return res.json({ model: null, message: "No model found. Build context from documents first." });
    return res.json({ model });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Failed to get model" });
  }
});

// ── Update model definition ──
contextRouter.put("/model", async (req, res) => {
  try {
    const userId = req.headers["x-user-id"] as string | undefined;
    const model = await getActiveModel(userId);
    if (!model) return res.status(404).json({ error: "No active model to update" });
    if (!req.body.model_definition) return res.status(400).json({ error: "model_definition is required" });
    await updateModel(model.model_id, req.body.model_definition);
    const updated = await getActiveModel(userId);
    return res.json({ model: updated });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Failed to update model" });
  }
});

// ── Check onboarding status (context + model existence) ──
contextRouter.get("/status", async (req, res) => {
  try {
    const userIdRaw = req.headers["x-user-id"] as string | undefined;
    const userId = await resolveUserId(userIdRaw);
    const ctx = await getActiveContext(userIdRaw);
    const model = await getActiveModel(userIdRaw);
    const ctxData = ctx?.context_data as Record<string, unknown> | undefined;
    return res.json({
      has_context: !!ctx,
      has_model: !!model,
      company_name: ctx?.company_name || null,
      industry: ctx?.industry || null,
      model_name: model?.name || null,
      currency: (ctxData?.currency as string) || "USD",
      currency_unit: (ctxData?.currency_unit as string) || "",
      ready: !!(ctx && model),
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Failed to check status" });
  }
});
