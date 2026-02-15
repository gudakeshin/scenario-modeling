import { Router } from "express";
import { getSession, createSession, resetSession, listSessions, addFollowUp } from "../services/sessionService.js";
import { getDefaultUserId } from "../db/index.js";

export const sessionsRouter = Router();

// Create session (attach to an existing scenario)
sessionsRouter.post("/", async (req, res) => {
  try {
    const { scenario_id } = req.body;
    if (!scenario_id) return res.status(400).json({ error: "scenario_id required" });
    const userId = (req.headers["x-user-id"] as string) || await getDefaultUserId();
    const sessionId = createSession(scenario_id, userId);
    return res.status(201).json({ session_id: sessionId, scenario_id });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Failed to create session" });
  }
});

// Get session
sessionsRouter.get("/:id", async (req, res) => {
  const s = getSession(req.params.id);
  if (!s) return res.status(404).json({ error: "Session not found or expired" });
  return res.json(s);
});

// List sessions
sessionsRouter.get("/", async (req, res) => {
  const userId = req.query.user_id as string | undefined;
  return res.json({ sessions: listSessions(userId) });
});

// Follow-up turn
sessionsRouter.post("/:id/follow-up", async (req, res) => {
  try {
    const { nl_input } = req.body;
    if (!nl_input || typeof nl_input !== "string") return res.status(400).json({ error: "nl_input required" });
    const result = await addFollowUp(req.params.id, nl_input.trim());
    return res.json(result);
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes("not found") || msg.includes("expired")) return res.status(404).json({ error: msg });
    console.error(e);
    return res.status(500).json({ error: "Follow-up failed" });
  }
});

// Reset session
sessionsRouter.delete("/:id", async (req, res) => {
  resetSession(req.params.id);
  return res.json({ ok: true });
});
