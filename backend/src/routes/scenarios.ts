import { Router } from "express";
import { z } from "zod";
import { parseScenario, toTypedDelta } from "../services/parser.js";
import { resolveToModelVariable } from "../services/mappingService.js";
import { runSimulation } from "../services/simulationService.js";
import { compareScenarios } from "../services/comparisonService.js";
import {
  generateNarrative,
  extractSinglePeriodPl,
  resolveScenarioCurrencySymbol,
} from "../services/narrativeService.js";
import { generateBusinessAnalysis, regenerateWithFeedback, regenerateForGrounding, verifyEvidence } from "../services/businessAnalysisAgent.js";
import {
  evaluateAnalysis, buildScenarioContext, storeQAReport,
  QA_THRESHOLD, MAX_QA_ITERATIONS,
  type QAReport, type ReflectionStep,
} from "../services/qaAgent.js";
import { reflect } from "../services/reflectionService.js";
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
import { getWorkspaceModelId } from "../models/registry.js";
import { scopeOf } from "../middleware/workspace.js";
import { initSse, sendSse, endSse, wantsSse, onSseAbort, isSseWritable } from "../services/sse.js";
import { runScenarioReasoning } from "../services/scenarioReasoningAgent.js";
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
  addConstraint,
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
import {
  getEvaluableModelForScenario,
  loadScenarioOverrides,
  toDimensionalOverrides,
} from "../services/modelResolver.js";
import { DimensionalModel } from "../services/dimensionalModel.js";
import {
  previewSimulationForScenario,
  ConstraintViolationError,
  SimulationFiniteError,
} from "../services/simulationService.js";
import { getAgentReadiness } from "../services/scenarioReasoningAgent.js";

export const scenariosRouter = Router();

const povSliceSchema = z.object({
  pov: z.record(z.string().min(1)),
  metrics: z.array(z.string().min(1)).optional(),
});

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
    const { isDimensionalModelDefinition } = await import("../models/dimensions.js");
    const { pool } = await import("../db/index.js");
    const { DimensionalModel, factsToLeafMap } = await import("../services/dimensionalModel.js");

    const r = await pool.query(
      `SELECT model_definition, source_kind, snapshot_id FROM user_models
       WHERE workspace_id = $1 AND is_active = true
       ORDER BY created_at DESC LIMIT 1`,
      [req.workspace!.workspaceId],
    );
    if (r.rows.length === 0) {
      return res.json({ pl: {}, all_variables: {}, time_horizon: null, needs_onboarding: true });
    }
    const row = r.rows[0];
    const model = row.model_definition;

    let baseValues: Record<string, number>;
    let plMetrics: string[];
    const timeHorizon = model.time_horizon;

    if (row.source_kind === "external_model" && isDimensionalModelDefinition(model) && row.snapshot_id) {
      const factsRes = await pool.query(
        `SELECT measure_id, member_key, value::float AS value FROM external_model_facts WHERE snapshot_id = $1`,
        [row.snapshot_id],
      );
      const dm = new DimensionalModel(model, factsToLeafMap(factsRes.rows));
      baseValues = dm.baseValues();
      plMetrics = dm.outputIds;
    } else {
      baseValues = await compute(model);
      plMetrics = getMetrics(model);
    }

    const pl: Record<string, number> = {};
    for (const id of plMetrics) {
      if (id in baseValues) pl[id] = Math.round(baseValues[id] * 100) / 100;
    }
    return res.json({ pl, all_variables: baseValues, time_horizon: timeHorizon });
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

/**
 * SSE: reflection progress stream.
 *
 * POST /api/v1/scenarios/reflect/stream
 * Body: { nl_input: string }
 * Events: progress → done | error → end
 *
 * Non-streaming fallback: use POST /parse (reflection embedded in parse result).
 */
scenariosRouter.post("/reflect/stream", requireRole("analyst"), async (req, res) => {
  const nlInput = typeof req.body?.nl_input === "string" ? req.body.nl_input.trim() : "";
  if (!nlInput) return res.status(400).json({ error: "nl_input is required" });

  initSse(res);
  let aborted = false;
  onSseAbort(req, res, () => {
    aborted = true;
  });
  try {
    if (!aborted && isSseWritable(res)) {
      sendSse(res, "progress", { stage: "reflecting", detail: "Running pre-parse reflection…" });
    }
    const scope = scopeOf(req);
    const result = await reflect(nlInput, null, scope);
    if (aborted || !isSseWritable(res)) return;
    if (!result) {
      sendSse(res, "done", { reflection: null, detail: "Reflection unavailable (no API key or model)" });
    } else {
      sendSse(res, "done", {
        reflection: {
          thinking: result.thinking,
          intent: result.summary.intent,
          assumptions: result.summary.assumptions,
          second_order_effects: result.summary.second_order_effects,
          duration_ms: result.duration_ms,
        },
      });
    }
  } catch (e) {
    if (isSseWritable(res)) {
      sendSse(res, "error", { error: (e as Error).message || "Reflection failed" });
    }
  }
  if (isSseWritable(res)) endSse(res);
});

/**
 * SSE: open-ended agent progress.
 * POST /api/v1/scenarios/agent/stream
 * Body: { nl_input: string, scenario_id?: string }
 * Events: progress → done { result } | error → end
 * Non-streaming fallback: create/parse with SHOWCASE_AGENT_ENABLED.
 */
scenariosRouter.post("/agent/stream", requireRole("analyst"), async (req, res) => {
  const nlInput = typeof req.body?.nl_input === "string" ? req.body.nl_input.trim() : "";
  if (!nlInput) return res.status(400).json({ error: "nl_input is required" });
  const scenarioId =
    typeof req.body?.scenario_id === "string" && req.body.scenario_id
      ? String(req.body.scenario_id)
      : undefined;

  initSse(res);
  let aborted = false;
  onSseAbort(req, res, () => {
    aborted = true;
  });
  try {
    const scope = scopeOf(req);
    if (!aborted && isSseWritable(res)) {
      sendSse(res, "progress", { stage: "readiness", detail: "Checking agent readiness…" });
    }
    if (!aborted && isSseWritable(res)) {
      sendSse(res, "progress", { stage: "reasoning", detail: "Running tool loop…" });
    }
    const result = await runScenarioReasoning(nlInput, scope, scenarioId);
    if (aborted || !isSseWritable(res)) return;
    sendSse(res, "done", {
      result: {
        parameters: result.parameters,
        causal_chain: result.causal_chain,
        citations: result.citations,
        confidence: result.confidence,
        clarification_needed: result.clarification_needed,
        follow_up_questions: result.follow_up_questions,
        agent_trace: result.agent_trace,
        stopped_reason: result.stopped_reason,
        preview_pl: result.preview_pl ?? result.final_preview_pl,
        preview_reconciliation: result.preview_reconciliation,
        constraint_violations: result.constraint_violations,
        readiness: result.readiness,
        error: result.error,
      },
    });
  } catch (e) {
    if (isSseWritable(res)) {
      sendSse(res, "error", { error: (e as Error).message || "Agent stream failed" });
    }
  }
  if (isSseWritable(res)) endSse(res);
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

/** Showcase agent readiness — feature flag + validated model diagnostics. */
scenariosRouter.get("/agent-status", async (req, res) => {
  try {
    const readiness = await getAgentReadiness(scopeOf(req).workspaceId);
    return res.json({ agent: readiness });
  } catch (e) {
    logger.error({ err: e }, "Request failed");
    return res.status(500).json({ error: "Failed to get agent status" });
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
    const scenarioId = row.scenario_id as string;
    ensureScenarioContext(scenarioId);
    const parseResult = await parseScenario(nl_input.trim(), scope, scenarioId);
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
        `INSERT INTO scenario_parameters (scenario_id, extracted_name, mapped_variable_id, scenario_value, delta_type, confidence_score, status, member_scope)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7)`,
        [
          scenarioId,
          p.name,
          variableId,
          scenarioValue,
          deltaType,
          p.confidence,
          p.member_scope ? JSON.stringify(p.member_scope) : null,
        ]
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
    if (parseResult.agent_trace?.length || parseResult.causal_chain?.length) {
      await pool.query(
        `INSERT INTO scenario_outputs (scenario_id, output_type, output_data) VALUES ($1, 'agent_reasoning', $2)`,
        [
          scenarioId,
          JSON.stringify({
            agent_trace: parseResult.agent_trace ?? [],
            causal_chain: parseResult.causal_chain ?? [],
            citations: parseResult.citations ?? [],
            agent_confidence: parseResult.agent_confidence ?? null,
            preview_pl: parseResult.preview_pl ?? null,
          }),
        ],
      );
      await logAudit(
        scenarioId,
        "agent_reasoning",
        {
          step_count: parseResult.agent_trace?.length ?? 0,
          causal_links: parseResult.causal_chain?.length ?? 0,
          confidence: parseResult.agent_confidence ?? null,
        },
        creatorId,
      );
    }
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
      agent_trace: parseResult.agent_trace ?? undefined,
      causal_chain: parseResult.causal_chain ?? undefined,
      citations: parseResult.citations ?? undefined,
      agent_confidence: parseResult.agent_confidence ?? undefined,
      preview_pl: parseResult.preview_pl ?? undefined,
      preview_reconciliation: parseResult.preview_reconciliation ?? undefined,
      constraint_violations: parseResult.constraint_violations ?? undefined,
      agent_readiness: parseResult.agent_readiness ?? undefined,
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
    type RefineAnswer = {
      question_id: string;
      answer: string;
      answer_kind?: "accepted_recommendation" | "overridden" | "custom" | "comment";
      recommended_value?: string;
    };
    const typedAnswers = answers as RefineAnswer[];
    const answerContext = typedAnswers
      .map((a) => {
        const kind = a.answer_kind;
        if (kind === "accepted_recommendation") {
          return `- ${a.question_id}: ${a.answer} (user confirmed the system recommendation)`;
        }
        if (kind === "overridden") {
          const prev = a.recommended_value ? ` of "${a.recommended_value}"` : "";
          return `- ${a.question_id}: ${a.answer} (user overrode the recommendation${prev})`;
        }
        if (kind === "comment") {
          return `- ${a.question_id} (open comment): ${a.answer}`;
        }
        if (kind === "custom") {
          return `- ${a.question_id}: ${a.answer} (custom answer)`;
        }
        return `- ${a.question_id}: ${a.answer}`;
      })
      .join("\n");
    const enrichedInput = `${originalInput}\n\nAdditional context from user:\n${answerContext}`;

    // Re-parse with the enriched input
    await hydrateScenarioContext(sid);
    const parseResult = await parseScenario(enrichedInput, {
      userId: sRes.rows[0].creator_id,
      workspaceId: scenarioWorkspaceId,
    }, sid);

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
        `INSERT INTO scenario_parameters (scenario_id, extracted_name, mapped_variable_id, scenario_value, delta_type, confidence_score, status, member_scope)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7)`,
        [
          sid,
          p.name,
          variableId,
          scenarioValue,
          deltaType,
          p.confidence,
          p.member_scope ? JSON.stringify(p.member_scope) : null,
        ]
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
    for (const answer of typedAnswers) {
      addQuestionHistory(
        sid,
        answer.question_id,
        String(answer.answer || ""),
        paramsWithMapping.map((p) => p.mapped_variable_id),
        {
          answerKind: answer.answer_kind,
          recommendedValue: answer.recommended_value,
        },
      );
    }

    const acceptedCount = typedAnswers.filter((a) => a.answer_kind === "accepted_recommendation").length;
    const overriddenCount = typedAnswers.filter((a) => a.answer_kind === "overridden").length;
    await logAudit(
      sid,
      "refined",
      {
        answer_count: typedAnswers.length,
        new_param_count: parseResult.parameters.length,
        accepted_recommendations: acceptedCount,
        overridden_recommendations: overriddenCount,
      },
      userId,
    );

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
      agent_trace: parseResult.agent_trace ?? undefined,
      causal_chain: parseResult.causal_chain ?? undefined,
      citations: parseResult.citations ?? undefined,
      agent_confidence: parseResult.agent_confidence ?? undefined,
      preview_pl: parseResult.preview_pl ?? undefined,
      preview_reconciliation: parseResult.preview_reconciliation ?? undefined,
      constraint_violations: parseResult.constraint_violations ?? undefined,
      agent_readiness: parseResult.agent_readiness ?? undefined,
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

const bulkDeleteSchema = z.object({
  scenario_ids: z.array(z.string().uuid()).min(1).max(100),
});

/**
 * Hard-delete a scenario and dependents. Clears self-FK base_case_id refs and
 * audit_trail rows (no ON DELETE CASCADE on that FK).
 */
async function hardDeleteScenario(scenarioId: string): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE scenarios SET base_case_id = NULL WHERE base_case_id = $1`,
      [scenarioId],
    );
    await client.query(`DELETE FROM audit_trail WHERE scenario_id = $1`, [scenarioId]);
    const r = await client.query(`DELETE FROM scenarios WHERE scenario_id = $1 RETURNING scenario_id`, [
      scenarioId,
    ]);
    await client.query("COMMIT");
    return (r.rowCount ?? 0) > 0;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

scenariosRouter.post(
  "/bulk-delete",
  requireRole("analyst"),
  validateBody(bulkDeleteSchema),
  async (req, res) => {
    try {
      const ids = req.body.scenario_ids as string[];
      const deleted: string[] = [];
      const failed: Array<{ scenario_id: string; error: string }> = [];
      for (const sid of ids) {
        try {
          await assertCanWriteScenario(req.user!.userId, req.user!.role, sid);
          const ok = await hardDeleteScenario(sid);
          if (ok) deleted.push(sid);
          else failed.push({ scenario_id: sid, error: "Not found" });
        } catch (e) {
          failed.push({
            scenario_id: sid,
            error: (e as Error).message || "Failed",
          });
        }
      }
      return res.json({ deleted, failed });
    } catch (e) {
      logger.error({ err: e }, "Bulk delete failed");
      return res.status(500).json({ error: "Failed to delete scenarios" });
    }
  },
);

scenariosRouter.delete("/:id", requireRole("analyst"), async (req, res) => {
  try {
    const sid = req.params.id;
    await assertCanWriteScenario(req.user!.userId, req.user!.role, sid);
    const ok = await hardDeleteScenario(sid);
    if (!ok) return res.status(404).json({ error: "Scenario not found" });
    return res.status(204).send();
  } catch (e) {
    const status = authzError(e);
    if (status) return res.status(status).json({ error: (e as Error).message });
    logger.error({ err: e }, "Delete scenario failed");
    return res.status(500).json({ error: "Failed to delete scenario" });
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
      `SELECT parameter_id, extracted_name, mapped_variable_id, base_value, scenario_value,
              delta_type, member_scope, confidence_score, status, binding_evidence, needs_review,
              owner_user_id, source_citation, rationale, effective_from, review_status
       FROM scenario_parameters WHERE scenario_id = $1 ORDER BY created_at`,
      [req.params.id]
    );
    // node-pg returns NUMERIC as string; coerce so clients always get numbers.
    let parameters = r.rows.map((row) => ({
      ...row,
      base_value: row.base_value == null ? null : Number(row.base_value),
      scenario_value: row.scenario_value == null ? null : Number(row.scenario_value),
      confidence_score: row.confidence_score == null ? null : Number(row.confidence_score),
      needs_review: Boolean(row.needs_review),
    }));

    // Enrich missing binding evidence from the live XLSX runtime when available.
    const missing = parameters.filter((p) => !p.binding_evidence);
    if (missing.length > 0) {
      try {
        const { getEvaluableModelForScenario } = await import("../services/modelResolver.js");
        const resolved = await getEvaluableModelForScenario(req.params.id);
        const runtime = resolved.model as {
          probeBindings?: (labels?: Map<string, string>) => Record<string, unknown>;
        };
        if (typeof runtime.probeBindings === "function") {
          const evidence = runtime.probeBindings();
          parameters = parameters.map((p) => {
            const ev = evidence[p.mapped_variable_id] as Record<string, unknown> | undefined;
            if (!ev || p.binding_evidence) return p;
            void pool.query(
              `UPDATE scenario_parameters
               SET binding_evidence = $1, needs_review = $2
               WHERE parameter_id = $3`,
              [JSON.stringify(ev), Boolean(ev.needsReview), p.parameter_id],
            );
            return {
              ...p,
              binding_evidence: ev,
              needs_review: Boolean(ev.needsReview) || p.needs_review,
              status: ev.needsReview && p.status === "pending" ? "needs_review" : p.status,
            };
          });
        }
      } catch {
        // Model may be formula_dag / unavailable — leave evidence empty.
      }
    }

    return res.json({ parameters });
  } catch (e) {
    const status = authzError(e);
    if (status) return res.status(status).json({ error: (e as Error).message });
    logger.error({ err: e }, "Request failed");
    return res.status(500).json({ error: "Failed to get parameters" });
  }
});

scenariosRouter.post("/:id/pov-slice", validateBody(povSliceSchema), async (req, res) => {
  try {
    const scenarioId = req.params.id;
    await assertCanReadScenario(req.user!.userId, req.user!.role, scenarioId);
    const scenario = await pool.query(
      "SELECT status FROM scenarios WHERE scenario_id = $1",
      [scenarioId],
    );
    if (scenario.rows.length === 0) return res.status(404).json({ error: "Scenario not found" });
    if (scenario.rows[0].status !== "completed") {
      return res.status(409).json({ error: "Scenario must be completed before requesting a POV slice" });
    }

    const resolved = await getEvaluableModelForScenario(scenarioId);
    if (resolved.source !== "external_model" || !(resolved.model instanceof DimensionalModel)) {
      return res.status(422).json({ error: "POV slices require a dimensional external model" });
    }
    const def = resolved.dimensionalDef!;
    const { pov, metrics: requestedMetrics } = req.body as z.infer<typeof povSliceSchema>;
    for (const [dimensionId, memberId] of Object.entries(pov)) {
      const dimension = def.dimensions.find((item) => item.id === dimensionId);
      if (!dimension || !dimension.members.some((member) => member.id === memberId)) {
        return res.status(400).json({
          error: `Unknown POV member '${memberId}' for dimension '${dimensionId}'`,
        });
      }
    }
    const metrics = requestedMetrics ?? resolved.model.outputIds;
    const unknownMetrics = metrics.filter((metric) => !resolved.model.outputIds.includes(metric));
    if (unknownMetrics.length > 0) {
      return res.status(400).json({ error: `Unknown metrics: ${unknownMetrics.join(", ")}` });
    }

    const overrides = toDimensionalOverrides(await loadScenarioOverrides(scenarioId));
    const result = resolved.model.evaluateDimensional(overrides);
    const pl = Object.fromEntries(
      metrics.map((metric) => [metric, Math.round((result.valueAt(metric, pov) ?? 0) * 100) / 100]),
    );

    const timeDimensionId = def.time_dimension_id;
    let periods:
      | Array<{ period: string; member_id: string; pl: Record<string, number> }>
      | undefined;
    if (timeDimensionId) {
      const timeDimension = def.dimensions.find((dimension) => dimension.id === timeDimensionId);
      if (timeDimension) {
        const selected = pov[timeDimensionId];
        const included = new Set<string>();
        if (selected) {
          const stack = [selected];
          while (stack.length > 0) {
            const current = stack.pop()!;
            const children = timeDimension.members.filter((member) => member.parentId === current);
            if (children.length === 0) included.add(current);
            else stack.push(...children.map((member) => member.id));
          }
        }
        const leaves = timeDimension.members
          .filter((member) => member.isLeaf && (!selected || included.has(member.id)))
          .sort((a, b) => a.ordinal - b.ordinal);
        periods = leaves.map((member) => ({
          period: member.name,
          member_id: member.id,
          pl: Object.fromEntries(
            metrics.map((metric) => [
              metric,
              Math.round(
                (result.valueAt(metric, { ...pov, [timeDimensionId]: member.id }) ?? 0) * 100,
              ) / 100,
            ]),
          ),
        }));
      }
    }

    const breakdowns: Record<string, Record<string, Record<string, number>>> = {};
    for (const metric of metrics) {
      breakdowns[metric] = {};
      for (const dimension of def.dimensions) {
        if (dimension.type === "version") continue;
        const selected = pov[dimension.id];
        const roots = dimension.members.filter((member) => !member.parentId);
        const members = selected
          ? dimension.members.filter((member) => member.id === selected)
          : dimension.members.filter(
              (member) =>
                roots.includes(member) || roots.some((root) => member.parentId === root.id),
            );
        const values = Object.fromEntries(
          members.map((member) => [
            member.id,
            Math.round(
              (result.valueAt(metric, { ...pov, [dimension.id]: member.id }) ?? 0) * 100,
            ) / 100,
          ]),
        );
        if (Object.keys(values).length > 0) breakdowns[metric][dimension.id] = values;
      }
    }

    return res.json({ pl, ...(periods ? { periods } : {}), dimensional: { breakdowns } });
  } catch (e) {
    const status = authzError(e);
    if (status) return res.status(status).json({ error: (e as Error).message });
    logger.error({ err: e }, "POV slice failed");
    return res.status(500).json({ error: "Failed to compute POV slice" });
  }
});

scenariosRouter.put("/:id/parameters/:paramId", requireRole("analyst"), validateBody(updateParameterSchema), async (req, res) => {
  try {
    const userId = req.user!.userId;
    await assertCanWriteScenario(userId, req.user!.role, req.params.id);
    const {
      scenario_value,
      status,
      override_reason,
      owner_user_id,
      source_citation,
      rationale,
      effective_from,
      review_status,
    } = req.body;

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
    for (const [column, value] of [
      ["owner_user_id", owner_user_id],
      ["source_citation", source_citation],
      ["rationale", rationale],
      ["effective_from", effective_from],
      ["review_status", review_status],
    ] as const) {
      if (value !== undefined) {
        updates.push(`${column} = $${i++}`);
        values.push(value);
      }
    }
    values.push(req.params.id, req.params.paramId);
    const r = await pool.query(
      `UPDATE scenario_parameters SET ${updates.join(", ")}
       WHERE scenario_id = $${i++} AND parameter_id = $${i}
       RETURNING parameter_id, extracted_name, mapped_variable_id, scenario_value,
                 status, is_override, override_reason, owner_user_id, source_citation,
                 rationale, effective_from, review_status`,
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
    await logAudit(req.params.id, "parameter_updated", {
      parameter_id: req.params.paramId,
      new_value: scenario_value,
      status,
      review_status,
      assumptions_metadata_updated:
        owner_user_id !== undefined ||
        source_citation !== undefined ||
        rationale !== undefined ||
        effective_from !== undefined,
    }, userId);
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

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const scenarioRow = await client.query(
        "SELECT creator_id, status FROM scenarios WHERE scenario_id = $1 FOR UPDATE",
        [sid],
      );
      if (scenarioRow.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Scenario not found" });
      }

      if (
        config.ENFORCE_MAKER_CHECKER &&
        scenarioRow.rows[0].creator_id === userId
      ) {
        await logAudit(
          sid,
          "self_approval_blocked",
          { attempted_by: userId },
          userId,
          undefined,
          undefined,
          client,
        );
        await client.query("COMMIT");
        return res.status(403).json({
          error: "Maker-checker: the scenario creator cannot approve it",
        });
      }

      const params = await client.query(
        "SELECT status FROM scenario_parameters WHERE scenario_id = $1",
        [sid],
      );
      if (params.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "No parameters to approve" });
      }
      const hasAccepted = params.rows.some((p: { status: string }) => p.status === "accepted");
      if (!hasAccepted) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "At least one parameter must be accepted before approval" });
      }

      const updated = await client.query(
        `UPDATE scenarios
         SET status = 'approved', approved_at = NOW(), approved_by = $2
         WHERE scenario_id = $1 AND status <> 'approved'
         RETURNING scenario_id, status`,
        [sid, userId],
      );

      if (updated.rows.length === 0) {
        if (scenarioRow.rows[0]?.status === "approved") {
          await client.query("COMMIT");
          return res.json({ scenario_id: sid, status: "approved", idempotent: true });
        }
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Scenario not found" });
      }

      await logAudit(sid, "approved", { approved_by: userId }, userId, undefined, undefined, client);
      await client.query("COMMIT");
      return res.json({ scenario_id: sid, status: "approved" });
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  } catch (e) {
    const status = authzError(e);
    if (status) return res.status(status).json({ error: (e as Error).message });
    logger.error({ err: e }, "Request failed");
    return res.status(500).json({ error: "Failed to approve scenario" });
  }
});

// ── Run simulation (requires approval) ──
scenariosRouter.post("/:id/run", requireRole("analyst"), async (req, res) => {
  const sid = req.params.id;
  const userId = req.user!.userId;
  let priorStatus: string | null = null;

  try {
    await assertCanWriteScenario(userId, req.user!.role, sid);

    const lockClient = await pool.connect();
    try {
      await lockClient.query("BEGIN");
      await lockClient.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [sid]);

      const sRes = await lockClient.query(
        "SELECT status FROM scenarios WHERE scenario_id = $1 FOR UPDATE",
        [sid],
      );
      if (sRes.rows.length === 0) {
        await lockClient.query("ROLLBACK");
        return res.status(404).json({ error: "Scenario not found" });
      }
      priorStatus = String(sRes.rows[0].status);
      if (priorStatus === "running") {
        await lockClient.query("ROLLBACK");
        return res.status(409).json({ error: "Simulation already in progress" });
      }
      if (priorStatus !== "approved" && priorStatus !== "completed") {
        await lockClient.query("ROLLBACK");
        return res.status(400).json({
          error: "Scenario must be approved before running. Accept parameters and click Approve first.",
        });
      }

      const flip = await lockClient.query(
        `UPDATE scenarios SET status = 'running', updated_at = NOW()
         WHERE scenario_id = $1 AND status IN ('approved', 'completed')
         RETURNING scenario_id`,
        [sid],
      );
      if (flip.rows.length === 0) {
        await lockClient.query("ROLLBACK");
        return res.status(409).json({ error: "Simulation already in progress" });
      }
      await lockClient.query("COMMIT");
    } catch (e) {
      await lockClient.query("ROLLBACK");
      throw e;
    } finally {
      lockClient.release();
    }

    await hydrateScenarioContext(sid);
    const output = await runSimulation(sid, { skipPersist: true });
    addComparisonVersion(sid, `run_${new Date().toISOString()}`, output.pl);

    const persistClient = await pool.connect();
    try {
      await persistClient.query("BEGIN");
      const outputData: Record<string, unknown> = {
        aggregate: output.pl,
        base_pl: output.base_pl,
        periods: output.periods,
        granularity: output.granularity,
        period_count: output.period_count,
        simulation_mode: output.simulation_mode,
        fidelity: output.fidelity,
        status: "completed",
        ...(output.dimensional ? { dimensional: output.dimensional } : {}),
        ...(output.absurdity_warnings?.length ? { absurdity_warnings: output.absurdity_warnings } : {}),
        ...(output.notices?.length ? { notices: output.notices } : {}),
        ...(output.formula_error_metrics?.length ? { formula_error_metrics: output.formula_error_metrics } : {}),
      };
      const runInsert = await persistClient.query<{ output_id: string }>(
        `INSERT INTO scenario_outputs (scenario_id, output_type, output_data)
         VALUES ($1, 'pl', $2)
         RETURNING output_id`,
        [sid, JSON.stringify(outputData)],
      );
      await persistClient.query(
        `UPDATE scenarios SET status = 'completed', updated_at = NOW() WHERE scenario_id = $1`,
        [sid],
      );
      const { createScenarioVersion } = await import("../services/scenarioVersionService.js");
      const version = await createScenarioVersion(
        sid,
        {
          label: `run_${new Date().toISOString()}`,
          outputs: output.pl,
          userId,
          workspaceId: scopeOf(req).workspaceId,
        },
        persistClient,
      );
      const { createRunManifest } = await import("../services/runManifestService.js");
      const manifest = await createRunManifest(
        {
          runId: runInsert.rows[0].output_id,
          scenarioId: sid,
          scenarioVersionId: version.version_id,
          workspaceId: scopeOf(req).workspaceId,
          createdBy: userId,
          resolvedVariables: output.variables,
        },
        persistClient,
      );
      await logAudit(
        sid,
        "simulation_run",
        { metrics: Object.keys(output.pl) },
        userId,
        getTouchedLeverSnapshot(sid) as unknown as Record<string, unknown>[],
        undefined,
        persistClient,
      );
      await persistClient.query("COMMIT");
      return res.json({
        scenario_id: sid,
        run_id: runInsert.rows[0].output_id,
        manifest_hash: manifest.row_hash,
        ...output,
      });
    } catch (verErr) {
      await persistClient.query("ROLLBACK");
      logger.warn({ detail: (verErr as Error).message }, "[Versions] persist failed");
      throw verErr;
    } finally {
      persistClient.release();
    }

    throw new Error("Simulation persistence completed without response");
  } catch (e) {
    if (priorStatus === "approved" || priorStatus === "completed") {
      await pool
        .query(
          `UPDATE scenarios SET status = $2, updated_at = NOW() WHERE scenario_id = $1 AND status = 'running'`,
          [sid, priorStatus],
        )
        .catch((restoreErr) => {
          logger.error({ err: restoreErr, scenario_id: sid }, "Failed to restore scenario status after run error");
        });
    }
    if (e instanceof SimulationFiniteError) {
      return res.status(422).json({
        error: e.message,
        status: "failed",
        failure_reason: "core_metrics_non_finite",
        formula_error_metrics: e.formula_error_metrics,
      });
    }
    if (e instanceof ConstraintViolationError) {
      return res.status(422).json({ error: e.message, violations: e.violations });
    }
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
async function buildNarrativeForScenario(
  sid: string,
  audience: "board" | "internal",
): Promise<string> {
  const sRes = await pool.query("SELECT name, nl_input FROM scenarios WHERE scenario_id = $1", [sid]);
  if (sRes.rows.length === 0) throw Object.assign(new Error("Scenario not found"), { status: 404 });
  const oRes = await pool.query(
    "SELECT output_data FROM scenario_outputs WHERE scenario_id = $1 AND output_type = 'pl' ORDER BY created_at DESC LIMIT 1",
    [sid],
  );
  if (oRes.rows.length === 0) throw Object.assign(new Error("Run simulation first"), { status: 400 });
  const pRes = await pool.query(
    "SELECT extracted_name as name, mapped_variable_id, scenario_value FROM scenario_parameters WHERE scenario_id = $1 AND status != 'rejected'",
    [sid],
  );
  const currency_symbol = await resolveScenarioCurrencySymbol(sid);
  const narrative = await generateNarrative({
    scenario_name: sRes.rows[0].name,
    nl_input: sRes.rows[0].nl_input,
    // Same period basis as BA/QA: first period when multi-period, else aggregate/flat.
    pl: extractSinglePeriodPl(oRes.rows[0].output_data),
    parameters: pRes.rows.map((p: { name: string; scenario_value: number }) => ({
      name: p.name,
      direction: "change",
      magnitude: p.scenario_value,
      unit: "value",
    })),
    audience,
    currency_symbol,
  });
  await pool.query(
    "UPDATE scenario_outputs SET narrative_summary = $1 WHERE scenario_id = $2 AND output_type = 'pl'",
    [narrative, sid],
  );
  return narrative;
}

/**
 * Narrative generation.
 *
 * Non-streaming (default): POST /:id/narrative → { narrative }
 * SSE: POST /:id/narrative/stream  OR  POST /:id/narrative with Accept: text/event-stream
 *   Events: progress → done { narrative } | error → end
 */
scenariosRouter.post("/:id/narrative", requireRole("analyst"), async (req, res) => {
  try {
    const sid = req.params.id;
    await assertCanWriteScenario(req.user!.userId, req.user!.role, sid);
    const audience = req.body?.audience === "board" ? "board" : "internal";

    if (wantsSse(req)) {
      initSse(res);
      try {
        sendSse(res, "progress", { stage: "generating", detail: "Writing executive summary…" });
        const narrative = await buildNarrativeForScenario(sid, audience);
        sendSse(res, "done", { narrative });
      } catch (e) {
        const status = (e as { status?: number }).status;
        sendSse(res, "error", {
          error: (e as Error).message || "Failed to generate narrative",
          status: status ?? 500,
        });
      }
      endSse(res);
      return;
    }

    const narrative = await buildNarrativeForScenario(sid, audience);
    return res.json({ narrative });
  } catch (e) {
    const status = authzError(e) || (e as { status?: number }).status;
    if (status) return res.status(status).json({ error: (e as Error).message });
    logger.error({ err: e }, "Request failed");
    return res.status(500).json({ error: "Failed to generate narrative" });
  }
});

scenariosRouter.post("/:id/narrative/stream", requireRole("analyst"), async (req, res) => {
  try {
    const sid = req.params.id;
    await assertCanWriteScenario(req.user!.userId, req.user!.role, sid);
    const audience = req.body?.audience === "board" ? "board" : "internal";
    initSse(res);
    try {
      sendSse(res, "progress", { stage: "generating", detail: "Writing executive summary…" });
      const narrative = await buildNarrativeForScenario(sid, audience);
      sendSse(res, "done", { narrative });
    } catch (e) {
      sendSse(res, "error", { error: (e as Error).message || "Failed to generate narrative" });
    }
    endSse(res);
  } catch (e) {
    const status = authzError(e);
    if (status) return res.status(status).json({ error: (e as Error).message });
    if (!res.headersSent) {
      return res.status(500).json({ error: "Failed to generate narrative" });
    }
    sendSse(res, "error", { error: (e as Error).message });
    endSse(res);
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

const constraintBodySchema = z.object({
  type: z.enum(["ceiling", "floor"]),
  lever: z.string().min(1).max(255),
  max: z.number().finite().optional(),
  min: z.number().finite().optional(),
  reason: z.string().max(1000).default(""),
});

scenariosRouter.post("/:id/context/constraints", requireRole("analyst"), async (req, res) => {
  try {
    await assertCanWriteScenario(req.user!.userId, req.user!.role, req.params.id);
    const parsed = constraintBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.message });
    }
    const c = parsed.data;
    if (c.type === "ceiling" && c.max == null) {
      return res.status(400).json({ error: "ceiling constraints require max" });
    }
    if (c.type === "floor" && c.min == null) {
      return res.status(400).json({ error: "floor constraints require min" });
    }
    await hydrateScenarioContext(req.params.id);
    const ctx = addConstraint(req.params.id, {
      type: c.type,
      lever: c.lever,
      max: c.max,
      min: c.min,
      reason: c.reason || `${c.type} on ${c.lever}`,
    });
    return res.json({ scenario_id: req.params.id, context: ctx });
  } catch (e) {
    const status = authzError(e);
    if (status) return res.status(status).json({ error: (e as Error).message });
    logger.error({ err: e }, "Request failed");
    return res.status(500).json({ error: "Failed to add constraint" });
  }
});

const previewBodySchema = z.object({
  parameters: z
    .array(
      z.object({
        variable_id: z.string().min(1),
        value: z.coerce.number().finite(),
        delta_type: z.enum(["percent", "absolute", "additive"]).optional(),
      }),
    )
    .optional(),
});

scenariosRouter.post("/:id/preview", requireRole("analyst"), async (req, res) => {
  try {
    await assertCanWriteScenario(req.user!.userId, req.user!.role, req.params.id);
    const parsed = previewBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.message });
    }
    await hydrateScenarioContext(req.params.id);
    const overrides = parsed.data.parameters?.map((p) => ({
      variableId: p.variable_id,
      value: p.value,
      delta_type: (p.delta_type ?? "percent") as "percent" | "absolute" | "additive",
    }));
    const result = await previewSimulationForScenario(req.params.id, overrides);
    return res.json(result);
  } catch (e) {
    if (e instanceof SimulationFiniteError) {
      return res.status(422).json({
        error: e.message,
        status: "failed",
        failure_reason: "core_metrics_non_finite",
        formula_error_metrics: e.formula_error_metrics,
      });
    }
    if (e instanceof ConstraintViolationError) {
      return res.status(422).json({ error: e.message, violations: e.violations });
    }
    const status = authzError(e);
    if (status) return res.status(status).json({ error: (e as Error).message });
    logger.error({ err: e }, "Request failed");
    return res.status(500).json({ error: "Preview failed: " + (e as Error).message });
  }
});

// ── Business Analysis (read persisted) ──
scenariosRouter.get("/:id/business-analysis", async (req, res) => {
  try {
    const sid = req.params.id;
    await assertCanReadScenario(req.user!.userId, req.user!.role, sid);

    const r = await pool.query(
      `SELECT output_data, created_at FROM scenario_outputs
       WHERE scenario_id = $1 AND output_type = 'business_analysis'
       ORDER BY created_at DESC LIMIT 1`,
      [sid],
    );
    if (r.rows.length === 0) {
      return res.status(404).json({ error: "No business analysis stored for this scenario" });
    }

    const stored = r.rows[0].output_data as Record<string, unknown>;
    // Older rows stored analysis only — attach latest QA report if missing
    if (stored && stored.qa_report == null) {
      const qa = await pool.query(
        `SELECT output_data FROM scenario_outputs
         WHERE scenario_id = $1 AND output_type = 'qa_report'
         ORDER BY created_at DESC LIMIT 1`,
        [sid],
      );
      if (qa.rows.length > 0) {
        stored.qa_report = qa.rows[0].output_data;
      }
    }

    res.setHeader("Cache-Control", "no-store");
    return res.json({
      ...stored,
      created_at: r.rows[0].created_at,
    });
  } catch (e) {
    const status = authzError(e);
    if (status) return res.status(status).json({ error: (e as Error).message });
    logger.error({ err: e }, "Request failed");
    return res.status(500).json({ error: "Failed to load business analysis" });
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

        // ── Grounding first: refine on numeric mismatches before full LLM QA ──
        const groundStart = Date.now();
        let grounding: Awaited<ReturnType<typeof verifyEvidence>>;
        try {
          grounding = await verifyEvidence(currentAnalysis, sid);
        } catch (e) {
          logger.error({ err: e }, "[QA Agent] Pre-QA grounding check failed");
          grounding = {
            ok: false,
            mismatches: [{
              implication_title: "grounding_error",
              metric_id: "verify_evidence",
              claimed_value: 0,
              actual_value: undefined,
            }],
          };
        }

        if (!grounding.ok) {
          reflectionLog.push({
            agent: "Quality Assurance",
            action: `Grounding check #${iteration} — FAILED`,
            detail: `Numeric mismatches: ${grounding.mismatches.map((m) => `${m.metric_id} claimed ${m.claimed_value} vs ${m.actual_value ?? "N/A"}`).join("; ").slice(0, 300)}`,
            passed: false,
            duration_ms: Date.now() - groundStart,
          });

          if (iteration >= MAX_QA_ITERATIONS) {
            // Final iteration still runs LLM QA so the report captures the failure
            const qaStart = Date.now();
            const report = await evaluateAnalysis(currentAnalysis, scenarioContext, sid);
            report.iterations = iteration;
            qaReport = report;
            reflectionLog.push({
              agent: "Quality Assurance",
              action: `Evaluation #${iteration} — Score: ${report.overall_score}/10`,
              detail: `FAILED after grounding retries. ${report.summary}`,
              score: report.overall_score,
              passed: false,
              duration_ms: Date.now() - qaStart,
            });
            break;
          }

          const refineStart = Date.now();
          logger.info(`[BA Agent] Grounding refine (iteration ${iteration})...`);
          currentAnalysis = await regenerateForGrounding(sid, grounding.mismatches, iteration);
          reflectionLog.push({
            agent: "Business Analysis",
            action: `Refinement #${iteration} — fixing grounding mismatches`,
            detail: `Rewrote analysis to correct ${grounding.mismatches.length} numeric claim(s). New headline: "${currentAnalysis.headline.slice(0, 100)}".`,
            duration_ms: Date.now() - refineStart,
          });
          continue;
        }

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

        currentAnalysis = await regenerateWithFeedback(
          sid,
          report,
          iteration,
          report.grounding_mismatches,
        );
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

    const persisted = {
      ...currentAnalysis,
      qa_report: qaReport,
      reflection_log: reflectionLog,
    };

    await pool.query(
      `INSERT INTO scenario_outputs (scenario_id, output_type, output_data) VALUES ($1, 'business_analysis', $2)`,
      [sid, JSON.stringify(persisted)]
    );

    return res.json(persisted);
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
