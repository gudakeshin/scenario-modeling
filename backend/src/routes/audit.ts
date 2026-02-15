import { Router } from "express";
import { getAuditTrail, exportAuditCsv, exportAuditJson } from "../services/auditService.js";
import { requireRole } from "../middleware/rbac.js";

export const auditRouter = Router();

auditRouter.get("/", requireRole("analyst"), async (req, res) => {
  try {
    const scenario_id = req.query.scenario_id as string | undefined;
    const action_type = req.query.action_type as string | undefined;
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const offset = Number(req.query.offset) || 0;
    const result = await getAuditTrail({ scenario_id, action_type, limit, offset });
    return res.json(result);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Failed to get audit trail" });
  }
});

auditRouter.get("/export", requireRole("approver"), async (req, res) => {
  try {
    const scenario_id = req.query.scenario_id as string | undefined;
    const format = req.query.format === "json" ? "json" : "csv";
    if (format === "json") {
      const data = await exportAuditJson(scenario_id);
      return res.json(data);
    }
    const csv = await exportAuditCsv(scenario_id);
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=audit_trail.csv");
    return res.send(csv);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Failed to export audit trail" });
  }
});
