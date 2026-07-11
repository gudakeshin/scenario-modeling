import { Router } from "express";
import {
  runMonteCarlo,
  MC_DEFAULT_ITERATIONS,
  type DistributionConfig,
  type CorrelationSpec,
} from "../services/monteCarloService.js";
import { runSensitivity } from "../services/sensitivityService.js";
import { requireRole } from "../middleware/rbac.js";
import { validateBody } from "../middleware/validate.js";
import { logAudit } from "../services/auditService.js";
import { assertCanWriteScenario } from "../services/authzService.js";
import { monteCarloSchema, sensitivitySchema } from "../schemas/auth.js";
import { logger } from "../logger.js";

export const analysisRouter = Router();

function authzError(e: unknown) {
  return (e as { status?: number }).status;
}

// ── Monte Carlo ──
analysisRouter.post("/:id/monte-carlo", requireRole("analyst"), validateBody(monteCarloSchema), async (req, res) => {
  try {
    const scenarioId = req.params.id;
    await assertCanWriteScenario(req.user!.userId, req.user!.role, scenarioId);
    const iterations = req.body.iterations || MC_DEFAULT_ITERATIONS;
    const distributions: DistributionConfig[] = req.body.distributions || [];
    const correlations: CorrelationSpec[] | undefined = req.body.correlations;
    const seed = req.body.seed != null ? Number(req.body.seed) : undefined;

    // If no distributions provided, auto-generate from scenario parameters.
    // The distribution is over the parameter's DELTA (same semantics as the
    // deterministic scenario value), so delta_type is carried through.
    if (distributions.length === 0) {
      const { pool } = await import("../db/index.js");
      const pRes = await pool.query(
        "SELECT mapped_variable_id, scenario_value, delta_type FROM scenario_parameters WHERE scenario_id = $1 AND status IN ('pending','accepted','modified')",
        [scenarioId]
      );
      for (const row of pRes.rows) {
        distributions.push({
          variable_id: row.mapped_variable_id,
          type: "normal",
          base_value: Number(row.scenario_value),
          stddev: Math.abs(Number(row.scenario_value) * 0.15) || 1,
          delta_type: row.delta_type === "percent" ? "percent" : "absolute",
        });
      }
    }

    const result = await runMonteCarlo({ scenario_id: scenarioId, iterations, distributions, correlations, seed });
    await logAudit(scenarioId, "monte_carlo_run", { iterations: result.iterations, seed: result.seed }, req.user!.userId);
    return res.json(result);
  } catch (e) {
    const status = authzError(e);
    if (status) return res.status(status).json({ error: (e as Error).message });
    const msg = (e as Error).message;
    if (msg === "Scenario not found") return res.status(404).json({ error: msg });
    logger.error({ err: e }, "Request failed");
    return res.status(500).json({ error: "Monte Carlo simulation failed" });
  }
});

// ── Sensitivity / Tornado ──
analysisRouter.post("/:id/sensitivity", requireRole("analyst"), validateBody(sensitivitySchema), async (req, res) => {
  try {
    const scenarioId = req.params.id;
    await assertCanWriteScenario(req.user!.userId, req.user!.role, scenarioId);
    const target_metric = req.body.target_metric || "net_income";
    const swing_pct = req.body.swing_pct || 20;

    const result = await runSensitivity(scenarioId, target_metric, swing_pct);
    await logAudit(scenarioId, "sensitivity_run", { target_metric, swing_pct }, req.user!.userId);
    return res.json(result);
  } catch (e) {
    const status = authzError(e);
    if (status) return res.status(status).json({ error: (e as Error).message });
    const msg = (e as Error).message;
    if (msg === "Scenario not found") return res.status(404).json({ error: msg });
    logger.error({ err: e }, "Request failed");
    return res.status(500).json({ error: "Sensitivity analysis failed" });
  }
});
