/**
 * Workspace portfolio dashboard + scenario version lineage + actuals lanes.
 */

import { Router } from "express";
import { z } from "zod";
import { requireRole } from "../middleware/rbac.js";
import { scopeOf } from "../middleware/workspace.js";
import { getPortfolioDashboard } from "../services/dashboardService.js";
import {
  createScenarioVersion,
  diffScenarioVersions,
  listScenarioVersions,
  migrateComparisonVersionsFromContext,
} from "../services/scenarioVersionService.js";
import {
  assertCanReadScenario,
  assertCanWriteScenario,
} from "../services/authzService.js";
import { pool } from "../db/index.js";
import { logger } from "../logger.js";
import { validateBody } from "../middleware/validate.js";

export const portfolioRouter = Router();

portfolioRouter.get("/dashboard", async (req, res) => {
  try {
    const scope = scopeOf(req);
    const dashboard = await getPortfolioDashboard(scope.workspaceId);
    return res.json(dashboard);
  } catch (e) {
    logger.error({ err: e }, "Dashboard failed");
    return res.status(500).json({ error: "Failed to load dashboard" });
  }
});

portfolioRouter.get("/scenarios/:id/versions", async (req, res) => {
  try {
    await assertCanReadScenario(req.user!.userId, req.user!.role, req.params.id);
    const versions = await listScenarioVersions(req.params.id);
    return res.json({ versions });
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (status) return res.status(status).json({ error: (e as Error).message });
    return res.status(500).json({ error: "Failed to list versions" });
  }
});

portfolioRouter.post(
  "/scenarios/:id/versions",
  requireRole("analyst"),
  validateBody(
    z.object({
      label: z.string().optional(),
      outputs: z.record(z.number()),
    }),
  ),
  async (req, res) => {
    try {
      await assertCanWriteScenario(req.user!.userId, req.user!.role, req.params.id);
      const scope = scopeOf(req);
      const version = await createScenarioVersion(req.params.id, {
        label: req.body.label,
        outputs: req.body.outputs,
        userId: req.user!.userId,
        workspaceId: scope.workspaceId,
      });
      return res.status(201).json({ version });
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status) return res.status(status).json({ error: (e as Error).message });
      return res.status(500).json({ error: "Failed to create version" });
    }
  },
);

portfolioRouter.get("/scenarios/:id/versions/diff", async (req, res) => {
  try {
    await assertCanReadScenario(req.user!.userId, req.user!.role, req.params.id);
    const from = Number(req.query.from);
    const to = Number(req.query.to);
    if (!Number.isFinite(from) || !Number.isFinite(to)) {
      return res.status(400).json({ error: "from and to version numbers required" });
    }
    const diff = await diffScenarioVersions(req.params.id, from, to);
    return res.json(diff);
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (status) return res.status(status).json({ error: (e as Error).message });
    return res.status(500).json({ error: "Failed to diff versions" });
  }
});

portfolioRouter.post("/scenarios/:id/versions/migrate-context", requireRole("analyst"), async (req, res) => {
  try {
    await assertCanWriteScenario(req.user!.userId, req.user!.role, req.params.id);
    const n = await migrateComparisonVersionsFromContext(req.params.id);
    return res.json({ migrated: n });
  } catch (e) {
    return res.status(500).json({ error: "Failed to migrate versions" });
  }
});

const actualsSchema = z.object({
  facts: z
    .array(
      z.object({
        measure_id: z.string().min(1),
        period: z.string().min(1),
        value: z.number().finite(),
        version_lane: z.enum(["actual", "budget", "forecast"]).default("actual"),
        entity_key: z.string().optional(),
        currency: z.string().optional(),
        unit: z.string().optional(),
      }),
    )
    .min(1),
  source_kind: z.enum(["upload", "sac", "anaplan", "manual"]).default("upload"),
});

portfolioRouter.post("/actuals", requireRole("analyst"), validateBody(actualsSchema), async (req, res) => {
  try {
    const scope = scopeOf(req);
    const { facts, source_kind } = req.body as z.infer<typeof actualsSchema>;
    const inserted = [];
    for (const f of facts) {
      const r = await pool.query(
        `INSERT INTO actuals_facts (
           workspace_id, source_kind, measure_id, period, version_lane,
           entity_key, value, currency, unit
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING fact_id, measure_id, period, version_lane, value`,
        [
          scope.workspaceId,
          source_kind,
          f.measure_id,
          f.period,
          f.version_lane,
          f.entity_key ?? null,
          f.value,
          f.currency ?? null,
          f.unit ?? null,
        ],
      );
      inserted.push(r.rows[0]);
    }
    return res.status(201).json({ inserted_count: inserted.length, facts: inserted });
  } catch (e) {
    logger.error({ err: e }, "Actuals insert failed");
    return res.status(500).json({ error: "Failed to store actuals" });
  }
});

portfolioRouter.get("/actuals", async (req, res) => {
  try {
    const scope = scopeOf(req);
    const lane = typeof req.query.lane === "string" ? req.query.lane : null;
    const r = await pool.query(
      `SELECT fact_id, measure_id, period, version_lane, entity_key, value, currency, unit, created_at
       FROM actuals_facts
       WHERE workspace_id = $1
         AND ($2::text IS NULL OR version_lane = $2)
       ORDER BY period, measure_id
       LIMIT 5000`,
      [scope.workspaceId, lane],
    );
    return res.json({ facts: r.rows });
  } catch (e) {
    return res.status(500).json({ error: "Failed to load actuals" });
  }
});

portfolioRouter.get("/actuals/compare/:scenarioId", async (req, res) => {
  try {
    await assertCanReadScenario(req.user!.userId, req.user!.role, req.params.scenarioId);
    const scope = scopeOf(req);
    const pl = await pool.query(
      `SELECT output_data FROM scenario_outputs
       WHERE scenario_id = $1 AND output_type = 'pl'
       ORDER BY created_at DESC LIMIT 1`,
      [req.params.scenarioId],
    );
    const aggregate = (pl.rows[0]?.output_data as { aggregate?: Record<string, number> })?.aggregate || {};
    const actuals = await pool.query(
      `SELECT measure_id, period, version_lane, value
       FROM actuals_facts WHERE workspace_id = $1 AND version_lane = 'actual'`,
      [scope.workspaceId],
    );
    const budget = await pool.query(
      `SELECT measure_id, period, version_lane, value
       FROM actuals_facts WHERE workspace_id = $1 AND version_lane = 'budget'`,
      [scope.workspaceId],
    );
    const forecast = await pool.query(
      `SELECT measure_id, period, version_lane, value
       FROM actuals_facts WHERE workspace_id = $1 AND version_lane = 'forecast'`,
      [scope.workspaceId],
    );
    const comparison: Array<{
      measure_id: string;
      scenario: number | null;
      actual: number | null;
      budget: number | null;
      forecast: number | null;
      vs_actual: number | null;
      vs_budget: number | null;
      vs_forecast: number | null;
    }> = [];
    const measures = new Set([
      ...Object.keys(aggregate),
      ...actuals.rows.map((r: { measure_id: string }) => r.measure_id),
      ...budget.rows.map((r: { measure_id: string }) => r.measure_id),
      ...forecast.rows.map((r: { measure_id: string }) => r.measure_id),
    ]);
    const actualBy = new Map(
      actuals.rows.map((r: { measure_id: string; value: string }) => [
        r.measure_id,
        Number(r.value),
      ]),
    );
    const budgetBy = new Map(
      budget.rows.map((r: { measure_id: string; value: string }) => [
        r.measure_id,
        Number(r.value),
      ]),
    );
    const forecastBy = new Map(
      forecast.rows.map((r: { measure_id: string; value: string }) => [
        r.measure_id,
        Number(r.value),
      ]),
    );
    for (const m of measures) {
      const scenario = aggregate[m] ?? null;
      const actual = actualBy.get(m) ?? null;
      const bud = budgetBy.get(m) ?? null;
      const fcst = forecastBy.get(m) ?? null;
      comparison.push({
        measure_id: m,
        scenario,
        actual,
        budget: bud,
        forecast: fcst,
        vs_actual: scenario != null && actual != null ? scenario - actual : null,
        vs_budget: scenario != null && bud != null ? scenario - bud : null,
        vs_forecast: scenario != null && fcst != null ? scenario - fcst : null,
      });
    }
    return res.json({ scenario_id: req.params.scenarioId, comparison });
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (status) return res.status(status).json({ error: (e as Error).message });
    return res.status(500).json({ error: "Failed to compare actuals" });
  }
});
