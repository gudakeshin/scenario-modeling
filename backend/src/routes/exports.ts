import { Router } from "express";
import { exportToExcel, exportToCsv } from "../services/exportService.js";
import { exportToPptx } from "../services/pptxService.js";
import { requireRole } from "../middleware/rbac.js";

export const exportsRouter = Router();

exportsRouter.get("/:id/export/excel", requireRole("analyst"), async (req, res) => {
  try {
    const buf = await exportToExcel(req.params.id);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename=scenario_${req.params.id.slice(0, 8)}.xlsx`);
    return res.send(buf);
  } catch (e) {
    const msg = (e as Error).message;
    if (msg === "Scenario not found") return res.status(404).json({ error: msg });
    console.error(e);
    return res.status(500).json({ error: "Export failed" });
  }
});

exportsRouter.get("/:id/export/csv", requireRole("analyst"), async (req, res) => {
  try {
    const csv = await exportToCsv(req.params.id);
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename=scenario_${req.params.id.slice(0, 8)}.csv`);
    return res.send(csv);
  } catch (e) {
    const msg = (e as Error).message;
    if (msg === "Scenario not found") return res.status(404).json({ error: msg });
    console.error(e);
    return res.status(500).json({ error: "Export failed" });
  }
});

exportsRouter.get("/:id/export/pptx", requireRole("analyst"), async (req, res) => {
  try {
    const buf = await exportToPptx(req.params.id);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.presentationml.presentation");
    res.setHeader("Content-Disposition", `attachment; filename=scenario_${req.params.id.slice(0, 8)}.pptx`);
    return res.send(buf);
  } catch (e) {
    const msg = (e as Error).message;
    if (msg === "Scenario not found") return res.status(404).json({ error: msg });
    console.error(e);
    return res.status(500).json({ error: "PowerPoint export failed" });
  }
});
