import { Router } from "express";
import { pool, getDefaultUserId } from "../db/index.js";
import { requireRole } from "../middleware/rbac.js";
import { logAudit } from "../services/auditService.js";

export const usersRouter = Router();

// List users (admin only)
usersRouter.get("/", requireRole("admin"), async (_req, res) => {
  try {
    const result = await pool.query("SELECT user_id, email, name, role, department, created_at FROM users ORDER BY created_at DESC");
    return res.json(result.rows);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Failed to list users" });
  }
});

// Get current user profile
usersRouter.get("/me", async (req, res) => {
  try {
    const userId = req.headers["x-user-id"] as string | undefined;
    let r;
    if (userId) {
      // Support both UUID and email as identifier
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId);
      r = isUuid
        ? await pool.query("SELECT user_id, email, name, role, department, created_at FROM users WHERE user_id = $1", [userId])
        : await pool.query("SELECT user_id, email, name, role, department, created_at FROM users WHERE email = $1", [userId]);
    } else {
      // Fallback: get the default system user (created during DB init)
      const defaultId = await getDefaultUserId();
      r = await pool.query("SELECT user_id, email, name, role, department, created_at FROM users WHERE user_id = $1", [defaultId]);
    }
    if (r.rows.length === 0) return res.status(404).json({ error: "User not found" });
    return res.json(r.rows[0]);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Failed to get user" });
  }
});

// Update user role (admin only)
usersRouter.put("/:id/role", requireRole("admin"), async (req, res) => {
  try {
    const { role } = req.body;
    if (!["viewer", "analyst", "approver", "admin"].includes(role)) {
      return res.status(400).json({ error: "Invalid role" });
    }
    const r = await pool.query(
      "UPDATE users SET role = $2 WHERE user_id = $1 RETURNING user_id, email, name, role",
      [req.params.id, role]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: "User not found" });
    return res.json(r.rows[0]);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Failed to update role" });
  }
});

// Share scenario with user
usersRouter.post("/share", requireRole("analyst"), async (req, res) => {
  try {
    const { scenario_id, shared_with, permission } = req.body;
    if (!scenario_id || !shared_with) return res.status(400).json({ error: "scenario_id and shared_with required" });
    const perm = ["view", "edit"].includes(permission) ? permission : "view";
    const r = await pool.query(
      `INSERT INTO scenario_sharing (scenario_id, shared_with, permission) VALUES ($1, $2, $3)
       ON CONFLICT (scenario_id, shared_with) DO UPDATE SET permission = EXCLUDED.permission
       RETURNING sharing_id, scenario_id, shared_with, permission`,
      [scenario_id, shared_with, perm]
    );
    await logAudit(scenario_id, "shared", { shared_with, permission: perm });
    return res.status(201).json(r.rows[0]);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Failed to share scenario" });
  }
});

// List shares for a scenario
usersRouter.get("/shares/:scenarioId", requireRole("analyst"), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT ss.sharing_id, ss.shared_with, u.email, u.name, ss.permission, ss.created_at
       FROM scenario_sharing ss JOIN users u ON ss.shared_with = u.user_id
       WHERE ss.scenario_id = $1 ORDER BY ss.created_at`,
      [req.params.scenarioId]
    );
    return res.json(r.rows);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Failed to list shares" });
  }
});

// Revoke sharing
usersRouter.delete("/share/:sharingId", requireRole("analyst"), async (req, res) => {
  try {
    await pool.query("DELETE FROM scenario_sharing WHERE sharing_id = $1", [req.params.sharingId]);
    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Failed to revoke share" });
  }
});
