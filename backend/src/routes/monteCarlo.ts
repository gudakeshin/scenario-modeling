import { Router } from "express";
import {
  runMonteCarlo,
  MC_DEFAULT_ITERATIONS,
  type DistributionConfig,
  type CorrelationSpec,
} from "../services/monteCarloService.js";
import { runSensitivity, runTwoWaySensitivity } from "../services/sensitivityService.js";
import { runAttribution } from "../services/attributionService.js";
import { runGoalSeek } from "../services/goalSeekService.js";
import { runDriverTree, applyLeverValue } from "../services/driverTreeService.js";
import { requireRole } from "../middleware/rbac.js";
import { validateBody } from "../middleware/validate.js";
import { logAudit } from "../services/auditService.js";
import { assertCanWriteScenario, assertCanReadScenario } from "../services/authzService.js";
import {
  monteCarloSchema,
  sensitivitySchema,
  twoWaySensitivitySchema,
  attributionSchema,
  goalSeekSchema,
  driverTreeSchema,
  applyLeverSchema,
  fidelityAuditSchema,
} from "../schemas/auth.js";
import { logger } from "../logger.js";
import { pool } from "../db/index.js";
import {
  attemptDeterministicNormalization,
  checkInvariants,
} from "../services/financialInvariants.js";
import { reviewModelFidelity } from "../services/accountingFidelityAgent.js";
import { getEvaluableModelForScenario } from "../services/modelResolver.js";

export const analysisRouter = Router();

function authzError(e: unknown) {
  return (e as { status?: number }).status;
}

function handleAnalysisError(e: unknown, res: import("express").Response, fallback: string) {
  const status = authzError(e);
  if (status) return res.status(status).json({ error: (e as Error).message });
  const msg = (e as Error).message;
  if (msg === "Scenario not found") return res.status(404).json({ error: msg });
  const errStatus = (e as { status?: number }).status;
  if (errStatus === 422) return res.status(422).json({ error: msg });
  logger.error({ err: e }, "Request failed");
  return res.status(500).json({ error: fallback });
}

// ── Monte Carlo ──
analysisRouter.post("/:id/monte-carlo", requireRole("analyst"), validateBody(monteCarloSchema as never), async (req, res) => {
  try {
    const scenarioId = req.params.id;
    await assertCanWriteScenario(req.user!.userId, req.user!.role, scenarioId);
    const iterations = req.body.iterations || MC_DEFAULT_ITERATIONS;
    const distributions: DistributionConfig[] = req.body.distributions || [];
    const correlations: CorrelationSpec[] | undefined = req.body.correlations;
    const seed = req.body.seed != null ? Number(req.body.seed) : undefined;
    const historical_samples = req.body.historical_samples;

    const result = await runMonteCarlo({
      scenario_id: scenarioId,
      created_by: req.user!.userId,
      iterations,
      distributions,
      correlations,
      seed,
      historical_samples,
    });
    await logAudit(scenarioId, "monte_carlo_run", { iterations: result.iterations, seed: result.seed }, req.user!.userId);
    return res.json(result);
  } catch (e) {
    return handleAnalysisError(e, res, "Monte Carlo simulation failed");
  }
});

// ── Sensitivity / Tornado ──
analysisRouter.post("/:id/sensitivity", requireRole("analyst"), validateBody(sensitivitySchema), async (req, res) => {
  try {
    const scenarioId = req.params.id;
    await assertCanWriteScenario(req.user!.userId, req.user!.role, scenarioId);
    const target_metric = req.body.target_metric || "net_income";
    const swing_pct = req.body.swing_pct || 20;
    const percent_swing_pp = req.body.percent_swing_pp;

    const result = await runSensitivity(scenarioId, target_metric, swing_pct, percent_swing_pp);
    await logAudit(scenarioId, "sensitivity_run", { target_metric, swing_pct, percent_swing_pp }, req.user!.userId);
    return res.json(result);
  } catch (e) {
    return handleAnalysisError(e, res, "Sensitivity analysis failed");
  }
});

// ── Two-way sensitivity ──
analysisRouter.post(
  "/:id/sensitivity/two-way",
  requireRole("analyst"),
  validateBody(twoWaySensitivitySchema),
  async (req, res) => {
    try {
      const scenarioId = req.params.id;
      await assertCanWriteScenario(req.user!.userId, req.user!.role, scenarioId);
      const target_metric = req.body.target_metric || "net_income";
      const result = await runTwoWaySensitivity(
        scenarioId,
        target_metric,
        req.body.variable_a,
        req.body.variable_b,
        req.body.swings,
        req.body.swing_by_variable,
        req.body.percent_swing_pp,
      );
      await logAudit(
        scenarioId,
        "sensitivity_two_way",
        { target_metric, variable_a: req.body.variable_a, variable_b: req.body.variable_b },
        req.user!.userId,
      );
      return res.json(result);
    } catch (e) {
      return handleAnalysisError(e, res, "Two-way sensitivity failed");
    }
  },
);

// ── Attribution (Shapley) ──
analysisRouter.post("/:id/attribution", requireRole("analyst"), validateBody(attributionSchema), async (req, res) => {
  try {
    const scenarioId = req.params.id;
    await assertCanWriteScenario(req.user!.userId, req.user!.role, scenarioId);
    const target_metric = req.body.target_metric || "net_income";
    const result = await runAttribution(scenarioId, target_metric, {
      reason: !!req.body.reason,
    });
    await logAudit(scenarioId, "attribution_run", { target_metric, reason: !!req.body.reason }, req.user!.userId);
    return res.json(result);
  } catch (e) {
    return handleAnalysisError(e, res, "Attribution analysis failed");
  }
});

// ── Goal seek ──
analysisRouter.post("/:id/goal-seek", requireRole("analyst"), validateBody(goalSeekSchema), async (req, res) => {
  try {
    const scenarioId = req.params.id;
    await assertCanWriteScenario(req.user!.userId, req.user!.role, scenarioId);
    const result = await runGoalSeek(scenarioId, {
      target_metric: req.body.target_metric,
      target_value: req.body.target_value,
      variable_id: req.body.variable_id,
      low: req.body.low,
      high: req.body.high,
      tolerance: req.body.tolerance,
    });
    await logAudit(
      scenarioId,
      "goal_seek",
      { variable_id: req.body.variable_id, target_metric: result.target_metric, converged: result.converged },
      req.user!.userId,
    );
    return res.json(result);
  } catch (e) {
    return handleAnalysisError(e, res, "Goal seek failed");
  }
});

// ── Driver tree ──
analysisRouter.get("/:id/driver-tree", requireRole("analyst"), async (req, res) => {
  try {
    const scenarioId = req.params.id;
    await assertCanReadScenario(req.user!.userId, req.user!.role, scenarioId);
    const metric = (req.query.metric as string) || "net_income";
    const reason = req.query.reason === "1" || req.query.reason === "true";
    const result = await runDriverTree(scenarioId, metric, { reason });
    return res.json(result);
  } catch (e) {
    return handleAnalysisError(e, res, "Driver tree failed");
  }
});

analysisRouter.post("/:id/driver-tree", requireRole("analyst"), validateBody(driverTreeSchema), async (req, res) => {
  try {
    const scenarioId = req.params.id;
    await assertCanWriteScenario(req.user!.userId, req.user!.role, scenarioId);
    const metric = req.body.metric || req.body.target_metric || "net_income";

    const applied: Array<{ variable_id: string; parameter_id: string }> = [];
    if (Array.isArray(req.body.apply_levers)) {
      for (const lever of req.body.apply_levers) {
        const result = await applyLeverValue(scenarioId, lever.variable_id, lever.scenario_value, {
          delta_type: lever.delta_type,
          reason: "Driver tree lever edit",
        });
        applied.push({ variable_id: result.mapped_variable_id, parameter_id: result.parameter_id });
      }
    }

    const result = await runDriverTree(scenarioId, metric, { reason: !!req.body.reason });
    await logAudit(scenarioId, "driver_tree", { metric, applied_count: applied.length, reason: !!req.body.reason }, req.user!.userId);
    return res.json({ ...result, ...(applied.length > 0 ? { applied } : {}) });
  } catch (e) {
    return handleAnalysisError(e, res, "Driver tree failed");
  }
});

// ── On-demand accounting fidelity audit ──
analysisRouter.post(
  "/:id/fidelity-audit",
  requireRole("analyst"),
  validateBody(fidelityAuditSchema),
  async (req, res) => {
    try {
      const scenarioId = req.params.id;
      await assertCanWriteScenario(req.user!.userId, req.user!.role, scenarioId);

      let pl: Record<string, number> = req.body.pl ?? {};
      let basePl: Record<string, number> = {};
      if (!pl || Object.keys(pl).length === 0) {
        const out = await pool.query(
          `SELECT output_data FROM scenario_outputs
           WHERE scenario_id = $1 AND output_type = 'simulation'
           ORDER BY created_at DESC LIMIT 1`,
          [scenarioId],
        );
        const data = out.rows[0]?.output_data as {
          aggregate?: Record<string, number>;
          base_pl?: Record<string, number>;
        } | undefined;
        pl = data?.aggregate ?? {};
        basePl = data?.base_pl ?? {};
      }

      if (Object.keys(pl).length === 0) {
        // Fall back to model base evaluation
        try {
          const resolved = await getEvaluableModelForScenario(scenarioId);
          pl = resolved.model.evaluate({});
          basePl = { ...pl };
        } catch {
          return res.status(422).json({ error: "No P&L available to audit — run a simulation first" });
        }
      }

      const initial = checkInvariants(pl);
      const normalized = attemptDeterministicNormalization(pl);
      const agent = await reviewModelFidelity(
        {
          pl: normalized.pl,
          basePl,
          residualViolations: normalized.residualViolations,
          modelSummary: `fidelity-audit scenario=${scenarioId}`,
        },
        { applyGatedFixes: true },
      );

      const payload = {
        initial_violations: initial,
        deterministic: {
          applied: normalized.applied,
          residual: normalized.residualViolations,
          pl: normalized.pl,
        },
        agent: {
          findings: agent.findings,
          proposed_fixes: agent.proposedFixes,
          applied_fixes: agent.appliedFixes,
          residual_violations: agent.residualViolations,
          notices: agent.notices,
          summary: agent.summary,
          applied_pl: agent.appliedPl,
        },
      };

      await pool.query(
        `INSERT INTO scenario_outputs (scenario_id, output_type, output_data) VALUES ($1, 'fidelity_audit', $2)`,
        [scenarioId, JSON.stringify(payload)],
      );
      await logAudit(scenarioId, "fidelity_audit", {
        initial_count: initial.length,
        residual_count: agent.residualViolations.length,
        applied_fixes: agent.appliedFixes.length,
      }, req.user!.userId);

      return res.json(payload);
    } catch (e) {
      return handleAnalysisError(e, res, "Fidelity audit failed");
    }
  },
);

// ── Apply lever value (goal-seek / driver-tree) ──
analysisRouter.post(
  "/:id/parameters/apply-lever",
  requireRole("analyst"),
  validateBody(applyLeverSchema),
  async (req, res) => {
    try {
      const scenarioId = req.params.id;
      await assertCanWriteScenario(req.user!.userId, req.user!.role, scenarioId);
      const result = await applyLeverValue(scenarioId, req.body.variable_id, req.body.scenario_value, {
        delta_type: req.body.delta_type,
        reason: req.body.reason,
        status: req.body.status,
      });
      await logAudit(
        scenarioId,
        "parameter_applied",
        { variable_id: result.mapped_variable_id, scenario_value: result.scenario_value, created: result.created },
        req.user!.userId,
      );
      return res.json(result);
    } catch (e) {
      return handleAnalysisError(e, res, "Apply lever failed");
    }
  },
);
