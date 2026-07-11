import { Router } from "express";
import { pool } from "../db/index.js";
import { requireRole, type Role } from "../middleware/rbac.js";
import { validateBody } from "../middleware/validate.js";
import { shareSchema, updateRoleSchema } from "../schemas/auth.js";
import { logAudit } from "../services/auditService.js";
import { assertCanWriteScenario } from "../services/authzService.js";
import { logger } from "../logger.js";

export const usersRouter = Router();

const AVAILABLE_ROLES: { id: Role; label: string; description: string }[] = [
  { id: "viewer", label: "Viewer", description: "Can view scenarios and reports" },
  { id: "analyst", label: "Analyst", description: "Can create, edit, and share scenarios" },
  { id: "approver", label: "Approver", description: "Can approve scenarios for simulation" },
  { id: "admin", label: "Admin", description: "Full access including user management" },
];

usersRouter.get("/roles", (_req, res) => {
  return res.json({ roles: AVAILABLE_ROLES });
});

usersRouter.get("/", requireRole("admin"), async (_req, res) => {
  try {
    const result = await pool.query(
      "SELECT user_id, email, name, role, department, created_at, is_active FROM users ORDER BY created_at DESC"
    );
    return res.json(result.rows);
  } catch (e) {
    logger.error({ err: e }, "Request failed");
    return res.status(500).json({ error: "Failed to list users" });
  }
});

usersRouter.get("/me", async (req, res) => {
  try {
    const u = req.user!;
    const r = await pool.query(
      "SELECT user_id, email, name, role, department, created_at FROM users WHERE user_id = $1",
      [u.userId]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: "User not found" });
    return res.json(r.rows[0]);
  } catch (e) {
    logger.error({ err: e }, "Request failed");
    return res.status(500).json({ error: "Failed to get user" });
  }
});

/** Self-promotion removed — explicit 404 so /me is not treated as a user id. */
usersRouter.put("/me/role", (_req, res) => {
  return res.status(404).json({ error: "Self role changes are not allowed. Ask an admin." });
});

/** Admin-only role change — self-promotion endpoint removed. */
usersRouter.put(
  "/:id/role",
  requireRole("admin"),
  validateBody(updateRoleSchema),
  async (req, res) => {
    try {
      const { role } = req.body;
      const r = await pool.query(
        "UPDATE users SET role = $2 WHERE user_id = $1 RETURNING user_id, email, name, role",
        [req.params.id, role]
      );
      if (r.rows.length === 0) return res.status(404).json({ error: "User not found" });
      return res.json(r.rows[0]);
    } catch (e) {
      logger.error({ err: e }, "Request failed");
      return res.status(500).json({ error: "Failed to update role" });
    }
  }
);

usersRouter.post("/share", requireRole("analyst"), validateBody(shareSchema), async (req, res) => {
  try {
    const { scenario_id, shared_with, permission } = req.body;
    const perm = permission === "edit" ? "edit" : "view";
    await assertCanWriteScenario(req.user!.userId, req.user!.role, scenario_id);
    const r = await pool.query(
      `INSERT INTO scenario_sharing (scenario_id, shared_with, permission, shared_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (scenario_id, shared_with) DO UPDATE SET permission = EXCLUDED.permission
       RETURNING sharing_id, scenario_id, shared_with, permission`,
      [scenario_id, shared_with, perm, req.user!.userId]
    );
    await logAudit(scenario_id, "shared", { shared_with, permission: perm }, req.user!.userId);
    return res.status(201).json(r.rows[0]);
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (status) return res.status(status).json({ error: (e as Error).message });
    logger.error({ err: e }, "Request failed");
    return res.status(500).json({ error: "Failed to share scenario" });
  }
});

usersRouter.get("/shares/:scenarioId", requireRole("analyst"), async (req, res) => {
  try {
    await assertCanWriteScenario(req.user!.userId, req.user!.role, req.params.scenarioId);
    const r = await pool.query(
      `SELECT ss.sharing_id, ss.shared_with, u.email, u.name, ss.permission, ss.created_at
       FROM scenario_sharing ss JOIN users u ON ss.shared_with = u.user_id
       WHERE ss.scenario_id = $1 ORDER BY ss.created_at`,
      [req.params.scenarioId]
    );
    return res.json(r.rows);
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (status) return res.status(status).json({ error: (e as Error).message });
    logger.error({ err: e }, "Request failed");
    return res.status(500).json({ error: "Failed to list shares" });
  }
});

usersRouter.delete("/share/:sharingId", requireRole("analyst"), async (req, res) => {
  try {
    const existing = await pool.query(
      "SELECT scenario_id FROM scenario_sharing WHERE sharing_id = $1",
      [req.params.sharingId]
    );
    if (!existing.rows[0]) return res.status(404).json({ error: "Share not found" });
    await assertCanWriteScenario(req.user!.userId, req.user!.role, existing.rows[0].scenario_id);
    await pool.query("DELETE FROM scenario_sharing WHERE sharing_id = $1", [req.params.sharingId]);
    return res.json({ ok: true });
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (status) return res.status(status).json({ error: (e as Error).message });
    logger.error({ err: e }, "Request failed");
    return res.status(500).json({ error: "Failed to revoke share" });
  }
});
