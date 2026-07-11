/**
 * Workspace routes — list, create, rename, delete.
 * Deliberately uses only req.user (never req.workspace) so a stale persisted
 * workspace id in the client can't lock the user out of workspace management.
 */

import { Router } from "express";
import {
  listWorkspaces,
  createWorkspace,
  renameWorkspace,
  deleteWorkspace,
} from "../services/workspaceService.js";
import { requireRole } from "../middleware/rbac.js";
import { logger } from "../logger.js";

export const workspacesRouter = Router();

function statusOf(e: unknown) {
  return (e as { status?: number }).status;
}

workspacesRouter.get("/", async (req, res) => {
  try {
    const workspaces = await listWorkspaces(req.user!.userId);
    return res.json({ workspaces });
  } catch (e) {
    logger.error({ err: e }, "Failed to list workspaces");
    return res.status(500).json({ error: "Failed to list workspaces" });
  }
});

workspacesRouter.post("/", requireRole("analyst"), async (req, res) => {
  try {
    const workspace = await createWorkspace(req.user!.userId, req.body?.name);
    return res.status(201).json(workspace);
  } catch (e) {
    const status = statusOf(e);
    if (status) return res.status(status).json({ error: (e as Error).message });
    logger.error({ err: e }, "Failed to create workspace");
    return res.status(500).json({ error: "Failed to create workspace" });
  }
});

workspacesRouter.put("/:id", requireRole("analyst"), async (req, res) => {
  try {
    const workspace = await renameWorkspace(req.user!.userId, req.params.id, req.body?.name);
    return res.json(workspace);
  } catch (e) {
    const status = statusOf(e);
    if (status) return res.status(status).json({ error: (e as Error).message });
    logger.error({ err: e }, "Failed to rename workspace");
    return res.status(500).json({ error: "Failed to rename workspace" });
  }
});

workspacesRouter.delete("/:id", requireRole("analyst"), async (req, res) => {
  try {
    await deleteWorkspace(req.user!.userId, req.params.id);
    return res.json({ deleted: true, workspace_id: req.params.id });
  } catch (e) {
    const status = statusOf(e);
    if (status) return res.status(status).json({ error: (e as Error).message });
    logger.error({ err: e }, "Failed to delete workspace");
    return res.status(500).json({ error: "Failed to delete workspace" });
  }
});
