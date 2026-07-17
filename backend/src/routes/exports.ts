import { Router } from "express";
import { exportToExcel, exportToCsv } from "../services/exportService.js";
import { exportToPptx } from "../services/pptxService.js";
import { requireRole } from "../middleware/rbac.js";
import { assertCanReadScenario } from "../services/authzService.js";
import { logger } from "../logger.js";
import { renderBoardPackPdf } from "../services/boardPackService.js";

export const exportsRouter = Router();

function authzError(e: unknown) {
  return (e as { status?: number }).status;
}

exportsRouter.get("/:id/export/excel", requireRole("analyst"), async (req, res) => {
  try {
    await assertCanReadScenario(req.user!.userId, req.user!.role, req.params.id);
    const buf = await exportToExcel(req.params.id);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename=scenario_${req.params.id.slice(0, 8)}.xlsx`);
    return res.send(buf);
  } catch (e) {
    const status = authzError(e);
    if (status) return res.status(status).json({ error: (e as Error).message });
    const msg = (e as Error).message;
    if (msg === "Scenario not found") return res.status(404).json({ error: msg });
    logger.error({ err: e }, "Request failed");
    return res.status(500).json({ error: "Export failed" });
  }
});

exportsRouter.get("/:id/export/csv", requireRole("analyst"), async (req, res) => {
  try {
    await assertCanReadScenario(req.user!.userId, req.user!.role, req.params.id);
    const csv = await exportToCsv(req.params.id);
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename=scenario_${req.params.id.slice(0, 8)}.csv`);
    return res.send(csv);
  } catch (e) {
    const status = authzError(e);
    if (status) return res.status(status).json({ error: (e as Error).message });
    const msg = (e as Error).message;
    if (msg === "Scenario not found") return res.status(404).json({ error: msg });
    logger.error({ err: e }, "Request failed");
    return res.status(500).json({ error: "Export failed" });
  }
});

exportsRouter.get("/:id/export/pptx", requireRole("analyst"), async (req, res) => {
  try {
    await assertCanReadScenario(req.user!.userId, req.user!.role, req.params.id);
    const buf = await exportToPptx(req.params.id);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.presentationml.presentation");
    res.setHeader("Content-Disposition", `attachment; filename=scenario_${req.params.id.slice(0, 8)}.pptx`);
    return res.send(buf);
  } catch (e) {
    const status = authzError(e);
    if (status) return res.status(status).json({ error: (e as Error).message });
    const msg = (e as Error).message;
    if (msg === "Scenario not found") return res.status(404).json({ error: msg });
    logger.error({ err: e }, "Request failed");
    return res.status(500).json({ error: "PowerPoint export failed" });
  }
});

exportsRouter.post("/:id/export/pdf", requireRole("analyst"), async (req, res) => {
  try {
    await assertCanReadScenario(req.user!.userId, req.user!.role, req.params.id);
    const buf = await renderBoardPackPdf(req.params.id, req.user!.userId);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=scenario_${req.params.id.slice(0, 8)}_board_pack.pdf`,
    );
    return res.send(buf);
  } catch (e) {
    const status = authzError(e);
    if (status) return res.status(status).json({ error: (e as Error).message });
    logger.error({ err: e }, "PDF board-pack export failed");
    return res.status(500).json({ error: "PDF board-pack export failed" });
  }
});
