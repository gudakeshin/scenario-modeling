import { Router } from "express";
import { getSession, createSession, resetSession, listSessions, addFollowUp } from "../services/sessionService.js";
import { assertCanWriteScenario } from "../services/authzService.js";
import { validateBody } from "../middleware/validate.js";
import { createSessionSchema, followUpSchema } from "../schemas/auth.js";
import { logger } from "../logger.js";

export const sessionsRouter = Router();

function authzError(e: unknown) {
  return (e as { status?: number }).status;
}

// Create session (attach to an existing scenario)
sessionsRouter.post("/", validateBody(createSessionSchema), async (req, res) => {
  try {
    const { scenario_id } = req.body;
    const userId = req.user!.userId;
    await assertCanWriteScenario(userId, req.user!.role, scenario_id);
    const sessionId = await createSession(scenario_id, userId);
    return res.status(201).json({ session_id: sessionId, scenario_id });
  } catch (e) {
    const status = authzError(e);
    if (status) return res.status(status).json({ error: (e as Error).message });
    logger.error({ err: e }, "Request failed");
    return res.status(500).json({ error: "Failed to create session" });
  }
});

// Get session
sessionsRouter.get("/:id", async (req, res) => {
  const s = getSession(req.params.id);
  if (!s) return res.status(404).json({ error: "Session not found or expired" });
  if (s.user_id !== req.user!.userId && req.user!.role !== "admin") return res.status(403).json({ error: "Forbidden" });
  return res.json(s);
});

// List sessions
sessionsRouter.get("/", async (req, res) => {
  return res.json({ sessions: listSessions(req.user!.userId) });
});

// Follow-up turn
sessionsRouter.post("/:id/follow-up", validateBody(followUpSchema), async (req, res) => {
  try {
    const { nl_input } = req.body;
    const session = getSession(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found or expired" });
    if (session.user_id !== req.user!.userId && req.user!.role !== "admin") return res.status(403).json({ error: "Forbidden" });
    await assertCanWriteScenario(req.user!.userId, req.user!.role, session.scenario_id);
    const result = await addFollowUp(req.params.id, nl_input.trim(), req.user!.userId);
    return res.json(result);
  } catch (e) {
    const status = authzError(e);
    if (status) return res.status(status).json({ error: (e as Error).message });
    const msg = (e as Error).message;
    if (msg.includes("not found") || msg.includes("expired")) return res.status(404).json({ error: msg });
    logger.error({ err: e }, "Request failed");
    return res.status(500).json({ error: "Follow-up failed" });
  }
});

// Reset session
sessionsRouter.delete("/:id", async (req, res) => {
  const session = getSession(req.params.id);
  if (session && session.user_id !== req.user!.userId && req.user!.role !== "admin") return res.status(403).json({ error: "Forbidden" });
  resetSession(req.params.id);
  return res.json({ ok: true });
});
