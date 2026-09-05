import { Router } from "express";
import {
  loadBoardPackData,
  verifyBoardPackToken,
} from "../services/boardPackService.js";
import { logger } from "../logger.js";
import { pool } from "../db/index.js";
import {
  assertUpsIWorkspaceMembership,
  logUpsIAccess,
} from "../services/upsiGovernanceService.js";

export const boardPackPrintRouter = Router();

/** Token-authenticated data endpoint used only by the short-lived print page. */
boardPackPrintRouter.get("/:id", async (req, res) => {
  try {
    const token = typeof req.query.token === "string" ? req.query.token : "";
    if (!token) return res.status(401).json({ error: "Print token required" });
    const claims = await verifyBoardPackToken(token, req.params.id);
    const scenario = await pool.query<{ workspace_id: string | null }>(
      `SELECT workspace_id FROM scenarios WHERE scenario_id = $1`,
      [req.params.id],
    );
    if (!scenario.rows[0]) {
      return res.status(404).json({ error: "Scenario not found" });
    }
    const workspaceId = scenario.rows[0].workspace_id;
    if (workspaceId) {
      await assertUpsIWorkspaceMembership(claims.userId, workspaceId);
      await logUpsIAccess({
        workspaceId,
        userId: claims.userId,
        artifactType: "board_pack",
        artifactId: req.params.id,
        action: "export",
      });
    }
    return res.json(await loadBoardPackData(req.params.id));
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 403) {
      return res.status(403).json({
        error: (error as Error).message,
        code: (error as { code?: string }).code,
      });
    }
    logger.warn({ err: error }, "Board-pack print token rejected");
    return res.status(401).json({ error: "Invalid or expired print token" });
  }
});
