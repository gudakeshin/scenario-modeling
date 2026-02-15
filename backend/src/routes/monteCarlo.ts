import { Router } from "express";
import { runMonteCarlo, type DistributionConfig } from "../services/monteCarloService.js";
import { runSensitivity } from "../services/sensitivityService.js";
import { requireRole } from "../middleware/rbac.js";
import { logAudit } from "../services/auditService.js";

export const analysisRouter = Router();

// ── Monte Carlo ──
analysisRouter.post("/:id/monte-carlo", requireRole("analyst"), async (req, res) => {
  try {
    const scenarioId = req.params.id;
    const iterations = Number(req.body.iterations) || 1000;
    const distributions: DistributionConfig[] = req.body.distributions || [];

    // If no distributions provided, auto-generate from scenario parameters
    if (distributions.length === 0) {
      const { pool } = await import("../db/index.js");
      const pRes = await pool.query(
        "SELECT mapped_variable_id, scenario_value FROM scenario_parameters WHERE scenario_id = $1 AND status IN ('pending','accepted','modified')",
        [scenarioId]
      );
      for (const row of pRes.rows) {
        distributions.push({
          variable_id: row.mapped_variable_id,
          type: "normal",
          base_value: Number(row.scenario_value),
          stddev: Math.abs(Number(row.scenario_value) * 0.15) || 1,
        });
      }
    }

    const result = await runMonteCarlo({ scenario_id: scenarioId, iterations, distributions });
    await logAudit(scenarioId, "monte_carlo_run", { iterations: result.iterations });
    return res.json(result);
  } catch (e) {
    const msg = (e as Error).message;
    if (msg === "Scenario not found") return res.status(404).json({ error: msg });
    console.error(e);
    return res.status(500).json({ error: "Monte Carlo simulation failed" });
  }
});

// ── Sensitivity / Tornado ──
analysisRouter.post("/:id/sensitivity", requireRole("analyst"), async (req, res) => {
  try {
    const scenarioId = req.params.id;
    const target_metric = req.body.target_metric || "net_income";
    const swing_pct = Number(req.body.swing_pct) || 20;

    const result = await runSensitivity(scenarioId, target_metric, swing_pct);
    await logAudit(scenarioId, "sensitivity_run", { target_metric, swing_pct });
    return res.json(result);
  } catch (e) {
    const msg = (e as Error).message;
    if (msg === "Scenario not found") return res.status(404).json({ error: msg });
    console.error(e);
    return res.status(500).json({ error: "Sensitivity analysis failed" });
  }
});
