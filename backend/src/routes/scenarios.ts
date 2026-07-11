import { Router } from "express";
import { parseScenario, toTypedDelta } from "../services/parser.js";
import { resolveToModelVariable } from "../services/mappingService.js";
import { runSimulation } from "../services/simulationService.js";
import { compareScenarios } from "../services/comparisonService.js";
import { generateNarrative } from "../services/narrativeService.js";
import { generateBusinessAnalysis, regenerateWithFeedback } from "../services/businessAnalysisAgent.js";
import {
  evaluateAnalysis, buildScenarioContext, storeQAReport,
  QA_THRESHOLD, MAX_QA_ITERATIONS,
  type QAReport, type ReflectionStep,
} from "../services/qaAgent.js";
import { logAudit } from "../services/auditService.js";
import { requireRole } from "../middleware/rbac.js";
import { validateBody } from "../middleware/validate.js";
import { pool } from "../db/index.js";
import { config } from "../config.js";
import {
  assertCanReadScenario,
  assertCanWriteScenario,
  scenarioVisibilityClause,
} from "../services/authzService.js";
import { getWorkspaceModelId, getWorkspaceModelDefinition } from "../models/registry.js";
import { scopeOf } from "../middleware/workspace.js";
import {
  ensureScenarioContext,
  mergeTouchedLevers,
  getScenarioContext,
  lockLever,
  resetUnlockedLevers,
  addComparisonVersion,
  getTouchedLeverSnapshot,
  addQuestionHistory,
  hydrateScenarioContext,
} from "../services/scenarioContextService.js";
import {
  compareSchema,
  createScenarioSchema,
  lockLeverSchema,
  parseScenarioSchema,
  refineScenarioSchema,
  updateParameterSchema,
} from "../schemas/auth.js";
import { logger } from "../logger.js";

export const scenariosRouter = Router();

function authzError(e: unknown) {
  return (e as { status?: number }).status;
}

function sanitize(s: string): string {
  return s.replace(/[<>]/g, "").trim();
}

// ── Base case (before /:id routes) ──
scenariosRouter.get("/base-case", async (req, res) => {
  try {
    const { computeBaseCase: compute, getPLMetrics: getMetrics } = await import("../models/registry.js");
    const model = await getWorkspaceModelDefinition(req.workspace!.workspaceId);
    if (!model) {
      return res.json({ pl: {}, all_variables: {}, time_horizon: null, needs_onboarding: true });
    }
    const baseValues = await compute(model);
    const plMetrics = getMetrics(model);
    const pl: Record<string, number> = {};
    for (const id of plMetrics) {
      if (id in baseValues) pl[id] = Math.round(baseValues[id] * 100) / 100;
    }
    return res.json({ pl, all_variables: baseValues, time_horizon: model.time_horizon });
  } catch (e) {
    logger.error({ err: e }, "Request failed");
    return res.status(500).json({ error: "Failed to compute base case" });
  }
});

// ── Comparison (before /:id routes) ──
scenariosRouter.post("/compare", validateBody(compareSchema), async (req, res) => {
  try {
    const { scenario_ids } = req.body;
    for (const id of scenario_ids) {
      await assertCanReadScenario(req.user!.userId, req.user!.role, id);
    }
    const result = await compareScenarios(scenario_ids);
    return res.json(result);
  } catch (e) {
    const status = authzError(e);
    if (status) return res.status(status).json({ error: (e as Error).message });
    logger.error({ err: e }, "Request failed");
    return res.status(500).json({ error: "Comparison failed" });
  }
});

scenariosRouter.post("/parse", requireRole("analyst"), validateBody(parseScenarioSchema), async (req, res) => {
  try {
    const nl_input = sanitize(req.body.nl_input).slice(0, config.MAX_INPUT_LENGTH);
    if (!nl_input) return res.status(400).json({ error: "nl_input is required" });
    const result = await parseScenario(nl_input, scopeOf(req));
    return res.json(result);
  } catch (e) {
    logger.error({ err: e }, "Request failed");
    return res.status(500).json({ error: "Failed to parse scenario" });
  }
});

scenariosRouter.post("/", requireRole("analyst"), validateBody(createScenarioSchema), async (req, res) => {
  try {
    const { nl_input: rawInput, name } = req.body;
    const nl_input = sanitize(rawInput).slice(0, config.MAX_INPUT_LENGTH);
    if (!nl_input) return res.status(400).json({ error: "nl_input is required" });
    const scope = scopeOf(req);
    const creatorId = scope.userId;

    // Look up the workspace's active model
    const modelId = await getWorkspaceModelId(scope.workspaceId);
    if (!modelId) {
      return res.status(400).json({
        error: "No model found. Please upload documents and build your company context first.",
        needs_onboarding: true,
      });
    }

    // Auto-generate a short name from the input if none provided
    const autoName = name || nl_input.trim().split(/[.?!\n]/)[0].slice(0, 80).trim() || "Untitled Scenario";

    const r = await pool.query(
      `INSERT INTO scenarios (nl_input, name, status, creator_id, workspace_id, model_version_hash)
       VALUES ($1, $2, 'draft', $3, $4, $5)
       RETURNING scenario_id, nl_input, name, status, created_at`,
      [nl_input.trim(), autoName, creatorId, scope.workspaceId, modelId]
    );
    const row = r.rows[0];
    const parseResult = await parseScenario(nl_input.trim(), scope);
    const scenarioId = row.scenario_id;
    ensureScenarioContext(scenarioId);
    const paramsWithMapping: { name: string; mapped_variable_id: string; scenario_value: number; confidence: number }[] = [];
    for (const p of parseResult.parameters) {
      // Resolution priority:
      // 1. Parser's own LLM-suggested variable ID (highest quality)
      // 2. DB mapping lookup by name, category, or geography
      // 3. Fuzzy match fallback
      // 4. Last resort: synthetic extracted_* ID
      let variableId: string | null = null;

      // 1. Parser suggestion (from LLM or heuristic)
      if (p.suggested_variable_id) {
        variableId = p.suggested_variable_id;
      }

      // 2. DB mapping lookup
      if (!variableId) {
        variableId = await resolveToModelVariable(p.name)
          || (p.scope?.category ? await resolveToModelVariable(p.scope.category) : null)
          || (p.scope?.geography ? await resolveToModelVariable(`geo_${p.scope.geography}`) : null);
      }

      // 3. Fallback: synthetic ID (clearly marked as unresolved)
      if (!variableId) {
        variableId = `extracted_${p.name.replace(/\W+/g, "_").toLowerCase()}`;
      }

      // Signed, typed delta (direction and percent/absolute semantics preserved)
      const { value: scenarioValue, delta_type: deltaType } = toTypedDelta(p);
      paramsWithMapping.push({
        name: p.name,
        mapped_variable_id: variableId,
        scenario_value: scenarioValue,
        confidence: p.confidence,
      });
      await pool.query(
        `INSERT INTO scenario_parameters (scenario_id, extracted_name, mapped_variable_id, scenario_value, delta_type, confidence_score, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending')`,
        [scenarioId, p.name, variableId, scenarioValue, deltaType, p.confidence]
      );
    }
    mergeTouchedLevers(
      scenarioId,
      paramsWithMapping.map((p) => ({
        id: p.mapped_variable_id,
        value: p.scenario_value,
        confidence: p.confidence,
        nlSource: nl_input.trim(),
        source: "parser_extract" as const,
      })),
    );
    await logAudit(scenarioId, "created", { nl_input: nl_input.trim(), param_count: parseResult.parameters.length, has_search: !!parseResult.search_context }, creatorId);
    return res.status(201).json({
      scenario_id: row.scenario_id,
      nl_input: row.nl_input,
      name: row.name,
      status: row.status,
      created_at: row.created_at,
      parameters: parseResult.parameters.map((p, i) => ({
        ...p,
        mapped_variable_id: paramsWithMapping[i]?.mapped_variable_id,
      })),
      clarification_needed: parseResult.clarification_needed,
      follow_up_questions: parseResult.follow_up_questions ?? undefined,
      search_context: parseResult.search_context ?? undefined,
      reflection: parseResult.reflection ?? undefined,
      notices: parseResult.notices ?? undefined,
    });
  } catch (e) {
    logger.error({ err: e }, "Request failed");
    return res.status(500).json({ error: "Failed to create scenario" });
  }
});

// ── Refine scenario with follow-up answers ──
scenariosRouter.post("/:id/refine", requireRole("analyst"), validateBody(refineScenarioSchema), async (req, res) => {
  try {
    const sid = req.params.id;
    const userId = req.user!.userId;
    await assertCanWriteScenario(userId, req.user!.role, sid);
    const { answers } = req.body;
    // answers: { question_id: string, answer: string }[]
    if (!Array.isArray(answers) || answers.length === 0) {
      return res.status(400).json({ error: "answers array is required" });
    }

    // Get original scenario input plus its workspace — refinement must parse
    // against the scenario's own workspace, not the caller's active one.
    const sRes = await pool.query(
      "SELECT nl_input, creator_id, workspace_id FROM scenarios WHERE scenario_id = $1",
      [sid]
    );
    if (sRes.rows.length === 0) return res.status(404).json({ error: "Scenario not found" });
    let scenarioWorkspaceId: string | null = sRes.rows[0].workspace_id;
    if (!scenarioWorkspaceId) {
      const { ensureDefaultWorkspace } = await import("../services/workspaceService.js");
      scenarioWorkspaceId = await ensureDefaultWorkspace(sRes.rows[0].creator_id);
    }

    // Build an enriched input that combines the original query with the user's answers
    const originalInput = sRes.rows[0].nl_input;
    const answerContext = answers
      .map((a: { question_id: string; answer: string }) => `- ${a.question_id}: ${a.answer}`)
      .join("\n");
    const enrichedInput = `${originalInput}\n\nAdditional context from user:\n${answerContext}`;

    // Re-parse with the enriched input
    await hydrateScenarioContext(sid);
    const parseResult = await parseScenario(enrichedInput, {
      userId: sRes.rows[0].creator_id,
      workspaceId: scenarioWorkspaceId,
    });

    // Persist enriched input so downstream operations (narrative, analysis) have full context
    // Also reset status to 'draft' since parameters are being replaced
    await pool.query("UPDATE scenarios SET nl_input = $1, status = 'draft' WHERE scenario_id = $2", [enrichedInput, sid]);

    // Clear ALL existing parameters (pending + accepted) and replace with refined set
    await pool.query("DELETE FROM scenario_parameters WHERE scenario_id = $1 AND status IN ('pending', 'accepted')", [sid]);

    const paramsWithMapping: { name: string; mapped_variable_id: string; scenario_value: number; confidence: number }[] = [];
    for (const p of parseResult.parameters) {
      let variableId: string | null = null;
      if (p.suggested_variable_id) variableId = p.suggested_variable_id;
      if (!variableId) {
        variableId = await resolveToModelVariable(p.name)
          || (p.scope?.category ? await resolveToModelVariable(p.scope.category) : null)
          || (p.scope?.geography ? await resolveToModelVariable(`geo_${p.scope.geography}`) : null);
      }
      if (!variableId) variableId = `extracted_${p.name.replace(/\W+/g, "_").toLowerCase()}`;

      const { value: scenarioValue, delta_type: deltaType } = toTypedDelta(p);
      paramsWithMapping.push({ name: p.name, mapped_variable_id: variableId, scenario_value: scenarioValue, confidence: p.confidence });
      await pool.query(
        `INSERT INTO scenario_parameters (scenario_id, extracted_name, mapped_variable_id, scenario_value, delta_type, confidence_score, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending')`,
        [sid, p.name, variableId, scenarioValue, deltaType, p.confidence]
      );
    }
    mergeTouchedLevers(
      sid,
      paramsWithMapping.map((p) => ({
        id: p.mapped_variable_id,
        value: p.scenario_value,
        confidence: p.confidence,
        nlSource: enrichedInput,
        source: "parser_extract" as const,
      })),
    );
    for (const answer of answers) {
      addQuestionHistory(sid, answer.question_id, String(answer.answer || ""), paramsWithMapping.map((p) => p.mapped_variable_id));
    }

    await logAudit(sid, "refined", { answer_count: answers.length, new_param_count: parseResult.parameters.length }, userId);

    return res.json({
      scenario_id: sid,
      parameters: parseResult.parameters.map((p, i) => ({
        ...p,
        mapped_variable_id: paramsWithMapping[i]?.mapped_variable_id,
      })),
      follow_up_questions: parseResult.follow_up_questions ?? undefined,
      clarification_needed: parseResult.clarification_needed,
      search_context: parseResult.search_context ?? undefined,
      reflection: parseResult.reflection ?? undefined,
      notices: parseResult.notices ?? undefined,
    });
  } catch (e) {
    const status = authzError(e);
    if (status) return res.status(status).json({ error: (e as Error).message });
    logger.error({ err: e }, "Request failed");
    return res.status(500).json({ error: "Failed to refine scenario" });
  }
});

scenariosRouter.get("/", async (req, res) => {
  try {
    const vis = scenarioVisibilityClause(req.user!.userId, req.user!.role, req.workspace!.workspaceId);
    const r = await pool.query(
      `SELECT s.scenario_id, s.name, s.nl_input, s.status, s.created_at, s.updated_at,
              (s.creator_id <> $1) AS is_shared_with_me
       FROM scenarios s WHERE ${vis.sql} ORDER BY s.created_at DESC LIMIT 100`,
      vis.params
    );
    return res.json({ scenarios: r.rows });
  } catch (e) {
    logger.error({ err: e }, "Request failed");
    return res.status(500).json({ error: "Failed to list scenarios" });
  }
});

scenariosRouter.get("/:id", async (req, res) => {
  try {
    await assertCanReadScenario(req.user!.userId, req.user!.role, req.params.id);
    const r = await pool.query(
      `SELECT scenario_id, name, description, nl_input, status, model_version_hash, base_case_id, created_at, updated_at
       FROM scenarios WHERE scenario_id = $1`,
      [req.params.id]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: "Scenario not found" });
    return res.json(r.rows[0]);
  } catch (e) {
    const status = authzError(e);
    if (status) return res.status(status).json({ error: (e as Error).message });
    logger.error({ err: e }, "Request failed");
    return res.status(500).json({ error: "Failed to get scenario" });
  }
});

scenariosRouter.get("/:id/parameters", async (req, res) => {
  try {
    await assertCanReadScenario(req.user!.userId, req.user!.role, req.params.id);
    const r = await pool.query(
      `SELECT parameter_id, extracted_name, mapped_variable_id, base_value, scenario_value, confidence_score, status
       FROM scenario_parameters WHERE scenario_id = $1 ORDER BY created_at`,
      [req.params.id]
    );
    return res.json({ parameters: r.rows });
  } catch (e) {
    const status = authzError(e);
    if (status) return res.status(status).json({ error: (e as Error).message });
    logger.error({ err: e }, "Request failed");
    return res.status(500).json({ error: "Failed to get parameters" });
  }
});

scenariosRouter.put("/:id/parameters/:paramId", requireRole("analyst"), validateBody(updateParameterSchema), async (req, res) => {
  try {
    const userId = req.user!.userId;
    await assertCanWriteScenario(userId, req.user!.role, req.params.id);
    const { scenario_value, status, override_reason } = req.body;

    // Record override history if value is changing
    if (scenario_value !== undefined) {
      const prev = await pool.query(
        "SELECT scenario_value FROM scenario_parameters WHERE scenario_id = $1 AND parameter_id = $2",
        [req.params.id, req.params.paramId]
      );
      if (prev.rows.length > 0) {
        await pool.query(
          `INSERT INTO parameter_override_history (parameter_id, previous_value, new_value, changed_by, reason)
           VALUES ($1, $2, $3, $4, $5)`,
          [req.params.paramId, prev.rows[0].scenario_value, scenario_value, userId, override_reason || null]
        );
      }
    }

    const updates: string[] = [];
    const values: unknown[] = [];
    let i = 1;
    if (scenario_value !== undefined) {
      updates.push(`scenario_value = $${i++}`);
      values.push(scenario_value);
      updates.push(`is_override = TRUE`);
      if (override_reason) {
        updates.push(`override_reason = $${i++}`);
        values.push(override_reason);
      }
    }
    if (status !== undefined) {
      updates.push(`status = $${i++}`);
      values.push(status);
    }
    values.push(req.params.id, req.params.paramId);
    const r = await pool.query(
      `UPDATE scenario_parameters SET ${updates.join(", ")} WHERE scenario_id = $${i++} AND parameter_id = $${i} RETURNING parameter_id, extracted_name, mapped_variable_id, scenario_value, status, is_override, override_reason`,
      values
    );
    if (r.rows.length === 0) return res.status(404).json({ error: "Parameter not found" });
    if (scenario_value !== undefined) {
      mergeTouchedLevers(req.params.id, [{
        id: r.rows[0].mapped_variable_id,
        value: Number(scenario_value),
        confidence: 1,
        nlSource: "Manual parameter override",
        source: "manual_override",
      }]);
    }
    await logAudit(req.params.id, "parameter_updated", { parameter_id: req.params.paramId, new_value: scenario_value, status }, userId);
    return res.json(r.rows[0]);
  } catch (e) {
    const status = authzError(e);
    if (status) return res.status(status).json({ error: (e as Error).message });
    logger.error({ err: e }, "Request failed");
    return res.status(500).json({ error: "Failed to update parameter" });
  }
});

scenariosRouter.post("/:id/parameters/:paramId/reject", requireRole("analyst"), async (req, res) => {
  try {
    await assertCanWriteScenario(req.user!.userId, req.user!.role, req.params.id);
    const r = await pool.query(
      `UPDATE scenario_parameters SET status = 'rejected' WHERE scenario_id = $1 AND parameter_id = $2 RETURNING parameter_id`,
      [req.params.id, req.params.paramId]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: "Parameter not found" });
    return res.json({ parameter_id: r.rows[0].parameter_id, status: "rejected" });
  } catch (e) {
    const status = authzError(e);
    if (status) return res.status(status).json({ error: (e as Error).message });
    logger.error({ err: e }, "Request failed");
    return res.status(500).json({ error: "Failed to reject parameter" });
  }
});

// ── Approval gate ──
scenariosRouter.post("/:id/approve", requireRole("approver"), async (req, res) => {
  try {
    const sid = req.params.id;
    const userId = req.user!.userId;
    await assertCanWriteScenario(userId, req.user!.role, sid);
    const params = await pool.query(
      "SELECT status FROM scenario_parameters WHERE scenario_id = $1",
      [sid]
    );
    if (params.rows.length === 0) return res.status(400).json({ error: "No parameters to approve" });
    const hasAccepted = params.rows.some((p: { status: string }) => p.status === "accepted");
    if (!hasAccepted) {
      return res.status(400).json({ error: "At least one parameter must be accepted before approval" });
    }
    await pool.query(
      `UPDATE scenarios SET status = 'approved', approved_at = NOW(), approved_by = $2 WHERE scenario_id = $1`,
      [sid, userId]
    );
    await logAudit(sid, "approved", { approved_by: userId }, userId);
    return res.json({ scenario_id: sid, status: "approved" });
  } catch (e) {
    const status = authzError(e);
    if (status) return res.status(status).json({ error: (e as Error).message });
    logger.error({ err: e }, "Request failed");
    return res.status(500).json({ error: "Failed to approve scenario" });
  }
});

// ── Run simulation (requires approval) ──
scenariosRouter.post("/:id/run", requireRole("analyst"), async (req, res) => {
  try {
    const sid = req.params.id;
    const userId = req.user!.userId;
    await assertCanWriteScenario(userId, req.user!.role, sid);
    const sRes = await pool.query("SELECT status FROM scenarios WHERE scenario_id = $1", [sid]);
    if (sRes.rows.length === 0) return res.status(404).json({ error: "Scenario not found" });
    if (sRes.rows[0].status !== "approved" && sRes.rows[0].status !== "completed") {
      return res.status(400).json({ error: "Scenario must be approved before running. Accept parameters and click Approve first." });
    }
    await hydrateScenarioContext(sid);
    const output = await runSimulation(sid);
    addComparisonVersion(sid, `run_${new Date().toISOString()}`, output.pl);
    await logAudit(
      sid,
      "simulation_run",
      { metrics: Object.keys(output.pl) },
      userId,
      getTouchedLeverSnapshot(sid) as unknown as Record<string, unknown>[],
    );
    return res.json({ scenario_id: sid, ...output });
  } catch (e) {
    const status = authzError(e);
    if (status) return res.status(status).json({ error: (e as Error).message });
    const msg = (e as Error).message;
    if (msg === "Scenario not found") return res.status(404).json({ error: msg });
    if (msg.includes("not validated")) return res.status(400).json({ error: msg, needs_validation: true });
    logger.error({ err: e }, "Request failed");
    return res.status(500).json({ error: "Simulation failed" });
  }
});

// ── Outputs ──
scenariosRouter.get("/:id/outputs", async (req, res) => {
  try {
    await assertCanReadScenario(req.user!.userId, req.user!.role, req.params.id);
    const r = await pool.query(
      `SELECT output_id, output_type, output_data, narrative_summary, created_at
       FROM scenario_outputs WHERE scenario_id = $1 ORDER BY created_at DESC`,
      [req.params.id]
    );
    return res.json({ outputs: r.rows });
  } catch (e) {
    const status = authzError(e);
    if (status) return res.status(status).json({ error: (e as Error).message });
    logger.error({ err: e }, "Request failed");
    return res.status(500).json({ error: "Failed to get outputs" });
  }
});

// ── Narrative ──
scenariosRouter.post("/:id/narrative", requireRole("analyst"), async (req, res) => {
  try {
    const sid = req.params.id;
    await assertCanWriteScenario(req.user!.userId, req.user!.role, sid);
    const audience = req.body?.audience === "board" ? "board" : "internal";
    const sRes = await pool.query("SELECT name, nl_input FROM scenarios WHERE scenario_id = $1", [sid]);
    if (sRes.rows.length === 0) return res.status(404).json({ error: "Scenario not found" });
    const oRes = await pool.query(
      "SELECT output_data FROM scenario_outputs WHERE scenario_id = $1 AND output_type = 'pl' ORDER BY created_at DESC LIMIT 1",
      [sid]
    );
    if (oRes.rows.length === 0) return res.status(400).json({ error: "Run simulation first" });
    const pRes = await pool.query(
      "SELECT extracted_name as name, mapped_variable_id, scenario_value FROM scenario_parameters WHERE scenario_id = $1 AND status != 'rejected'",
      [sid]
    );
    const narrative = await generateNarrative({
      scenario_name: sRes.rows[0].name,
      nl_input: sRes.rows[0].nl_input,
      pl: oRes.rows[0].output_data?.aggregate ?? oRes.rows[0].output_data,
      parameters: pRes.rows.map((p: { name: string; scenario_value: number }) => ({
        name: p.name,
        direction: "change",
        magnitude: p.scenario_value,
        unit: "value",
      })),
      audience,
    });
    await pool.query(
      "UPDATE scenario_outputs SET narrative_summary = $1 WHERE scenario_id = $2 AND output_type = 'pl'",
      [narrative, sid]
    );
    return res.json({ narrative });
  } catch (e) {
    const status = authzError(e);
    if (status) return res.status(status).json({ error: (e as Error).message });
    logger.error({ err: e }, "Request failed");
    return res.status(500).json({ error: "Failed to generate narrative" });
  }
});

// ── Scenario context endpoints ──
scenariosRouter.get("/:id/context", async (req, res) => {
  try {
    await assertCanReadScenario(req.user!.userId, req.user!.role, req.params.id);
    const ctx = (await hydrateScenarioContext(req.params.id)) ?? getScenarioContext(req.params.id);
    if (!ctx) return res.status(404).json({ error: "Scenario context not found" });
    return res.json({ scenario_id: req.params.id, context: ctx });
  } catch (e) {
    const status = authzError(e);
    if (status) return res.status(status).json({ error: (e as Error).message });
    logger.error({ err: e }, "Request failed");
    return res.status(500).json({ error: "Failed to get scenario context" });
  }
});

scenariosRouter.post("/:id/context/reset", requireRole("analyst"), async (req, res) => {
  try {
    await assertCanWriteScenario(req.user!.userId, req.user!.role, req.params.id);
    await hydrateScenarioContext(req.params.id);
    const ctx = resetUnlockedLevers(req.params.id);
    return res.json({ scenario_id: req.params.id, context: ctx });
  } catch (e) {
    const status = authzError(e);
    if (status) return res.status(status).json({ error: (e as Error).message });
    logger.error({ err: e }, "Request failed");
    return res.status(500).json({ error: "Failed to reset scenario context" });
  }
});

scenariosRouter.post("/:id/context/lock", requireRole("analyst"), validateBody(lockLeverSchema), async (req, res) => {
  try {
    await assertCanWriteScenario(req.user!.userId, req.user!.role, req.params.id);
    const { lever_id, locked } = req.body;
    await hydrateScenarioContext(req.params.id);
    const ctx = lockLever(req.params.id, lever_id, !!locked);
    return res.json({ scenario_id: req.params.id, context: ctx });
  } catch (e) {
    const status = authzError(e);
    if (status) return res.status(status).json({ error: (e as Error).message });
    logger.error({ err: e }, "Request failed");
    return res.status(500).json({ error: "Failed to lock scenario lever" });
  }
});

// ── Business Analysis Agent + QA Reflection Loop ──
scenariosRouter.post("/:id/business-analysis", requireRole("analyst"), async (req, res) => {
  try {
    const sid = req.params.id;
    await assertCanWriteScenario(req.user!.userId, req.user!.role, sid);
    const sRes = await pool.query("SELECT status FROM scenarios WHERE scenario_id = $1", [sid]);
    if (sRes.rows.length === 0) return res.status(404).json({ error: "Scenario not found" });

    const skipQA = req.query.skip_qa === "true";
    const reflectionLog: ReflectionStep[] = [];

    // ── Step 1: Business Analysis Agent generates initial analysis ──
    const baStart = Date.now();
    let currentAnalysis = await generateBusinessAnalysis(sid);
    reflectionLog.push({
      agent: "Business Analysis",
      action: "Initial analysis generated",
      detail: `Headline: "${currentAnalysis.headline.slice(0, 120)}". ${currentAnalysis.implications.length} implications, ${currentAnalysis.risks.length} risks, ${currentAnalysis.recommendations.length} recommendations.`,
      duration_ms: Date.now() - baStart,
    });
    logger.info(`[BA Agent] Initial analysis generated (${Date.now() - baStart}ms)`);

    let qaReport: QAReport | null = null;

    if (!skipQA) {
      const scenarioContext = await buildScenarioContext(sid);
      let iteration = 0;

      while (iteration < MAX_QA_ITERATIONS) {
        iteration++;

        // ── QA Agent evaluates ──
        const qaStart = Date.now();
        const report = await evaluateAnalysis(currentAnalysis, scenarioContext, sid);
        report.iterations = iteration;
        qaReport = report;

        const dimSummary = report.dimensions
          .map((d) => `${d.name}: ${d.score}/10`)
          .join(", ");
        reflectionLog.push({
          agent: "Quality Assurance",
          action: report.status === "not_assessed"
            ? `Evaluation #${iteration} — not assessed`
            : `Evaluation #${iteration} — Score: ${report.overall_score}/10`,
          detail: report.status === "not_assessed"
            ? `QA COULD NOT RUN. ${report.summary}`
            : report.passed
              ? `PASSED. ${report.summary}`
              : `FAILED (threshold: ${QA_THRESHOLD}/10). ${report.summary} [${dimSummary}]`,
          score: report.status === "not_assessed" ? undefined : report.overall_score,
          passed: report.status === "not_assessed" ? undefined : report.passed,
          duration_ms: Date.now() - qaStart,
        });
        logger.info(`[QA Agent] Iteration ${iteration}: ${report.status === "not_assessed" ? "NOT ASSESSED" : `${report.overall_score}/10 (${report.passed ? "PASSED" : "FAILED"})`} — ${Date.now() - qaStart}ms`);

        // Stop when QA passes, or when QA could not run at all — a QA
        // failure to execute must not be treated as an analysis pass.
        if (report.passed || report.status === "not_assessed") break;

        // ── Business Analysis Agent regenerates with QA feedback ──
        const refineStart = Date.now();
        logger.info(`[BA Agent] Regenerating with QA feedback (iteration ${iteration})...`);

        const lowestDims = [...report.dimensions]
          .sort((a, b) => a.score - b.score)
          .slice(0, 3)
          .map((d) => `${d.name} (${d.score}/10): ${d.feedback}`)
          .join("; ");

        currentAnalysis = await regenerateWithFeedback(sid, report, iteration);
        reflectionLog.push({
          agent: "Business Analysis",
          action: `Refinement #${iteration} — addressing QA feedback`,
          detail: `Regenerated analysis addressing: ${lowestDims}. New headline: "${currentAnalysis.headline.slice(0, 100)}".`,
          duration_ms: Date.now() - refineStart,
        });
        logger.info(`[BA Agent] Refinement ${iteration} complete (${Date.now() - refineStart}ms)`);
      }

      // If QA never passed after all iterations, mark it clearly
      if (qaReport && !qaReport.passed && qaReport.overall_score > 0) {
        qaReport.summary = `ANALYSIS QUALITY WARNING: After ${iteration} QA iterations, the analysis did not meet the quality threshold (${qaReport.overall_score}/${QA_THRESHOLD}). ${qaReport.summary}`;
        reflectionLog.push({
          agent: "Quality Assurance",
          action: "Quality threshold not met",
          detail: `After ${iteration} iterations, the analysis scored ${qaReport.overall_score}/10 (threshold: ${QA_THRESHOLD}). The analysis is returned with caveats. Key issues: ${qaReport.improvement_guidance.slice(0, 200)}`,
          score: qaReport.overall_score,
          passed: false,
          duration_ms: 0,
        });
      }

      if (qaReport) {
        await storeQAReport(sid, qaReport);
      }
    }

    await logAudit(sid, "business_analysis", {
      headline: currentAnalysis.headline.slice(0, 100),
      qa_score: qaReport?.overall_score,
      qa_iterations: qaReport?.iterations,
      qa_passed: qaReport?.passed,
    }, req.user!.userId);

    await pool.query(
      `INSERT INTO scenario_outputs (scenario_id, output_type, output_data) VALUES ($1, 'business_analysis', $2)`,
      [sid, JSON.stringify(currentAnalysis)]
    );

    return res.json({
      ...currentAnalysis,
      qa_report: qaReport,
      reflection_log: reflectionLog,
    });
  } catch (e) {
    const status = authzError(e);
    if (status) return res.status(status).json({ error: (e as Error).message });
    const msg = (e as Error).message;
    if (msg === "Scenario not found") return res.status(404).json({ error: msg });
    logger.error({ err: e }, "Request failed");
    return res.status(500).json({ error: "Business analysis failed" });
  }
});

// (compare route registered at top of file before /:id routes)
