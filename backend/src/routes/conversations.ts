/**
 * Chat conversation persistence API — list/get/create/update/append/delete,
 * scoped to the caller's active workspace (see middleware/workspace.ts).
 */

import { Router } from "express";
import { z } from "zod";
import { requireRole } from "../middleware/rbac.js";
import { scopeOf } from "../middleware/workspace.js";
import { validateBody } from "../middleware/validate.js";
import {
  createConversationSchema,
  updateConversationSchema,
  appendMessageSchema,
} from "../schemas/conversations.js";
import {
  ConversationError,
  listConversations,
  getConversation,
  createConversation,
  updateConversation,
  appendMessage,
  deleteConversation,
  deleteConversations,
} from "../services/conversationService.js";
import { logger } from "../logger.js";

export const conversationsRouter = Router();

function handleConvError(e: unknown, res: import("express").Response) {
  if (e instanceof ConversationError) {
    return res.status(e.status).json({ error: e.message });
  }
  logger.error({ err: e }, "Conversations route error");
  return res.status(500).json({ error: (e as Error).message || "Internal error" });
}

const bulkDeleteSchema = z.object({
  conversation_ids: z.array(z.string().uuid()).min(1).max(200),
});

// ── Bulk delete (before /:id) ──
conversationsRouter.post(
  "/bulk-delete",
  requireRole("viewer"),
  validateBody(bulkDeleteSchema),
  async (req, res) => {
    try {
      const deleted = await deleteConversations(scopeOf(req), req.body.conversation_ids);
      return res.json({ deleted });
    } catch (e) {
      return handleConvError(e, res);
    }
  },
);

// ── CRUD ──

conversationsRouter.get("/", requireRole("viewer"), async (req, res) => {
  try {
    const limit = Number(req.query.limit ?? 100);
    const rows = await listConversations(scopeOf(req), Number.isFinite(limit) ? limit : 100);
    return res.json({ conversations: rows });
  } catch (e) {
    return handleConvError(e, res);
  }
});

conversationsRouter.post(
  "/",
  requireRole("viewer"),
  validateBody(createConversationSchema),
  async (req, res) => {
    try {
      const row = await createConversation(scopeOf(req), req.body);
      return res.status(201).json(row);
    } catch (e) {
      return handleConvError(e, res);
    }
  },
);

conversationsRouter.get("/:id", requireRole("viewer"), async (req, res) => {
  try {
    const row = await getConversation(scopeOf(req), req.params.id);
    if (!row) return res.status(404).json({ error: "Conversation not found" });
    return res.json(row);
  } catch (e) {
    return handleConvError(e, res);
  }
});

conversationsRouter.put(
  "/:id",
  requireRole("viewer"),
  validateBody(updateConversationSchema),
  async (req, res) => {
    try {
      const row = await updateConversation(scopeOf(req), req.params.id, req.body);
      return res.json(row);
    } catch (e) {
      return handleConvError(e, res);
    }
  },
);

conversationsRouter.delete("/:id", requireRole("viewer"), async (req, res) => {
  try {
    await deleteConversation(scopeOf(req), req.params.id);
    return res.status(204).send();
  } catch (e) {
    return handleConvError(e, res);
  }
});

conversationsRouter.post(
  "/:id/messages",
  requireRole("viewer"),
  validateBody(appendMessageSchema),
  async (req, res) => {
    try {
      const row = await appendMessage(scopeOf(req), req.params.id, req.body);
      return res.status(201).json(row);
    } catch (e) {
      return handleConvError(e, res);
    }
  },
);
