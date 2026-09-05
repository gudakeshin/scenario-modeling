import { Router } from "express";
import { isPlanningConnectorsEnabled } from "../config.js";

export const configRouter = Router();

configRouter.get("/features", (_req, res) => {
  return res.json({
    planning_connectors_enabled: isPlanningConnectorsEnabled(),
  });
});
