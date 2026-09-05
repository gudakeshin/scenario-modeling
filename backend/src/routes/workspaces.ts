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
import { validateBody } from "../middleware/validate.js";
import { logger } from "../logger.js";
import { createWorkspaceSchema, renameWorkspaceSchema } from "../schemas/workspaces.js";
import { z } from "zod";
import {
  assertUpsIWorkspaceMembership,
  configureWorkspaceSensitivity,
  grantWorkspaceMembership,
  listUpsIAccessLog,
  listWorkspaceMemberships,
  logUpsIAccess,
  revokeWorkspaceMembership,
  verifyUpsIAccessChain,
} from "../services/upsiGovernanceService.js";

export const workspacesRouter = Router();

const governanceSchema = z.object({
  sensitivity: z.enum(["public", "confidential", "upsi"]),
  nature_of_upsi: z.string().max(500).nullable().optional(),
});
const workspaceMemberSchema = z.object({
  user_id: z.string().uuid(),
  access_reason: z.string().min(3).max(500),
});

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

workspacesRouter.post("/", requireRole("analyst"), validateBody(createWorkspaceSchema), async (req, res) => {
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

workspacesRouter.patch(
  "/:id/governance",
  requireRole("admin"),
  validateBody(governanceSchema),
  async (req, res) => {
    try {
      return res.json(await configureWorkspaceSensitivity({
        workspaceId: req.params.id,
        sensitivity: req.body.sensitivity,
        natureOfUpsi: req.body.nature_of_upsi,
      }));
    } catch (e) {
      const status = statusOf(e);
      if (status) return res.status(status).json({ error: (e as Error).message });
      logger.error({ err: e }, "Failed to update workspace governance");
      return res.status(500).json({ error: "Failed to update workspace governance" });
    }
  },
);

workspacesRouter.get("/:id/members", requireRole("admin"), async (req, res) => {
  try {
    return res.json({ members: await listWorkspaceMemberships(req.params.id) });
  } catch (e) {
    logger.error({ err: e }, "Failed to list workspace members");
    return res.status(500).json({ error: "Failed to list workspace members" });
  }
});

workspacesRouter.post(
  "/:id/members",
  requireRole("admin"),
  validateBody(workspaceMemberSchema),
  async (req, res) => {
    try {
      const member = await grantWorkspaceMembership({
        workspaceId: req.params.id,
        userId: req.body.user_id,
        grantedBy: req.user!.userId,
        accessReason: req.body.access_reason,
      });
      return res.status(201).json(member);
    } catch (e) {
      logger.error({ err: e }, "Failed to grant workspace membership");
      return res.status(500).json({ error: "Failed to grant workspace membership" });
    }
  },
);

workspacesRouter.delete("/:id/members/:userId", requireRole("admin"), async (req, res) => {
  try {
    await revokeWorkspaceMembership(req.params.id, req.params.userId);
    return res.json({ removed: true });
  } catch (e) {
    const status = statusOf(e);
    if (status) return res.status(status).json({ error: (e as Error).message });
    logger.error({ err: e }, "Failed to revoke workspace membership");
    return res.status(500).json({ error: "Failed to revoke workspace membership" });
  }
});

workspacesRouter.get("/:id/upsi-access-log", requireRole("admin"), async (req, res) => {
  try {
    await assertUpsIWorkspaceMembership(req.user!.userId, req.params.id);
    await logUpsIAccess({
      workspaceId: req.params.id,
      userId: req.user!.userId,
      artifactType: "sdd",
      artifactId: req.params.id,
      action: "export",
    });
    const [rows, verification] = await Promise.all([
      listUpsIAccessLog(req.params.id),
      verifyUpsIAccessChain(req.params.id),
    ]);
    if (req.query.format === "csv") {
      const quote = (value: unknown) => `"${String(value ?? "").replace(/"/g, "\"\"")}"`;
      const columns = [
        "access_id", "workspace_id", "user_id", "email", "artifact_type",
        "artifact_id", "action", "nature_of_upsi", "accessed_at", "prev_hash", "row_hash",
      ];
      const csv = [
        columns.join(","),
        ...rows.map((row) => columns.map((column) => quote(row[column])).join(",")),
      ].join("\n");
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="upsi-sdd-${req.params.id}.csv"`);
      return res.send(csv);
    }
    return res.json({ workspace_id: req.params.id, verification, access_log: rows });
  } catch (e) {
    const status = statusOf(e);
    if (status) return res.status(status).json({ error: (e as Error).message });
    logger.error({ err: e }, "Failed to export UPSI access log");
    return res.status(500).json({ error: "Failed to export UPSI access log" });
  }
});

workspacesRouter.put("/:id", requireRole("analyst"), validateBody(renameWorkspaceSchema), async (req, res) => {
  try {
    const workspace = await renameWorkspace(req.user!.userId, req.params.id, req.body.name);
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
