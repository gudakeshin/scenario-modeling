import { Router } from "express";
import { getAuditTrail, exportAuditCsv, exportAuditJson, verifyAuditChain } from "../services/auditService.js";
import { requireRole } from "../middleware/rbac.js";
import { logger } from "../logger.js";

export const auditRouter = Router();

auditRouter.get("/", requireRole("analyst"), async (req, res) => {
  try {
    const scenario_id = req.query.scenario_id as string | undefined;
    const action_type = req.query.action_type as string | undefined;
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const offset = Number(req.query.offset) || 0;
    const result = await getAuditTrail({
      scenario_id,
      action_type,
      limit,
      offset,
      userId: req.user!.userId,
      role: req.user!.role,
    });
    return res.json(result);
  } catch (e) {
    logger.error({ err: e }, "Request failed");
    return res.status(500).json({ error: "Failed to get audit trail" });
  }
});

auditRouter.get("/verify", requireRole("admin"), async (_req, res) => {
  try {
    const result = await verifyAuditChain();
    return res.json(result);
  } catch (e) {
    logger.error({ err: e }, "Request failed");
    return res.status(500).json({ error: "Failed to verify audit chain" });
  }
});

auditRouter.get("/export", requireRole("approver"), async (req, res) => {
  try {
    const scenario_id = req.query.scenario_id as string | undefined;
    const format = req.query.format === "json" ? "json" : "csv";
    const scope = {
      scenarioId: scenario_id,
      userId: req.user!.userId,
      role: req.user!.role,
    };
    if (format === "json") {
      const data = await exportAuditJson(scope);
      return res.json(data);
    }
    const csv = await exportAuditCsv(scope);
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=audit_trail.csv");
    return res.send(csv);
  } catch (e) {
    logger.error({ err: e }, "Request failed");
    return res.status(500).json({ error: "Failed to export audit trail" });
  }
});
