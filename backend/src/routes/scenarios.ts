import { Router } from "express";
import { parseScenario } from "../services/parser.js";
import { resolveToModelVariable } from "../services/mappingService.js";
import { runSimulation } from "../services/simulationService.js";
import { compareScenarios } from "../services/comparisonService.js";
import { generateNarrative } from "../services/narrativeService.js";
import { generateBusinessAnalysis } from "../services/businessAnalysisAgent.js";
import { logAudit } from "../services/auditService.js";
import { requireRole } from "../middleware/rbac.js";
import { pool, getDefaultUserId } from "../db/index.js";

export const scenariosRouter = Router();

// ── Input sanitization helpers ──
const MAX_INPUT_LENGTH = Number(process.env.MAX_INPUT_LENGTH) || 2000;

function sanitize(s: string): string {
  return s.replace(/[<>]/g, "").trim();
}
function validateLength(s: string, max: number, field: string): string | null {
  if (s.length > max) return `${field} exceeds maximum length of ${max} characters`;
  return null;
}

// ── Base case (before /:id routes) ──
scenariosRouter.get("/base-case", async (_req, res) => {
  try {
    const { computeBaseCase: compute, getModelDefinition: getModel, getPLMetrics: getMetrics } = await import("../models/registry.js");
    const baseValues = await compute();
    const model = await getModel();
    const plMetrics = getMetrics(model);
    const pl: Record<string, number> = {};
    for (const id of plMetrics) {
      if (id in baseValues) pl[id] = Math.round(baseValues[id] * 100) / 100;
    }
    return res.json({ pl, all_variables: baseValues, time_horizon: model.time_horizon });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Failed to compute base case" });
  }
});

// ── Comparison (before /:id routes) ──
scenariosRouter.post("/compare", async (req, res) => {
  try {
    const { scenario_ids } = req.body;
    if (!Array.isArray(scenario_ids) || scenario_ids.length < 1) {
      return res.status(400).json({ error: "Provide scenario_ids array (1–4)" });
    }
    const result = await compareScenarios(scenario_ids);
    return res.json(result);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Comparison failed" });
  }
});

scenariosRouter.post("/parse", async (req, res) => {
  try {
    const { nl_input: rawInput } = req.body;
    if (typeof rawInput !== "string" || !rawInput.trim()) {
      return res.status(400).json({ error: "nl_input is required and must be a non-empty string" });
    }
    const nl_input = sanitize(rawInput);
    const lenErr = validateLength(nl_input, MAX_INPUT_LENGTH, "nl_input");
    if (lenErr) return res.status(400).json({ error: lenErr });
    const result = await parseScenario(nl_input.trim());
    return res.json(result);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Failed to parse scenario" });
  }
});

scenariosRouter.post("/", async (req, res) => {
  try {
    const { nl_input, name } = req.body;
    if (typeof nl_input !== "string" || !nl_input.trim()) {
      return res.status(400).json({ error: "nl_input is required" });
    }
    const creatorId = await getDefaultUserId();
    const r = await pool.query(
      `INSERT INTO scenarios (nl_input, name, status, creator_id, model_version_hash)
       VALUES ($1, $2, 'draft', $3, 'v0')
       RETURNING scenario_id, nl_input, name, status, created_at`,
      [nl_input.trim(), name || null, creatorId]
    );
    const row = r.rows[0];
    const parseResult = await parseScenario(nl_input.trim());
    const scenarioId = row.scenario_id;
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

      // Default magnitude to 0 if the parser/LLM didn't extract a numeric value
      const scenarioValue = (p.magnitude != null && !isNaN(Number(p.magnitude))) ? Number(p.magnitude) : 0;
      paramsWithMapping.push({
        name: p.name,
        mapped_variable_id: variableId,
        scenario_value: scenarioValue,
        confidence: p.confidence,
      });
      await pool.query(
        `INSERT INTO scenario_parameters (scenario_id, extracted_name, mapped_variable_id, scenario_value, confidence_score, status)
         VALUES ($1, $2, $3, $4, $5, 'pending')`,
        [scenarioId, p.name, variableId, scenarioValue, p.confidence]
      );
    }
    await logAudit(scenarioId, "created", { nl_input: nl_input.trim(), param_count: parseResult.parameters.length, has_search: !!parseResult.search_context });
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
    console.error(e);
    return res.status(500).json({ error: "Failed to create scenario" });
  }
});

// ── Refine scenario with follow-up answers ──
scenariosRouter.post("/:id/refine", async (req, res) => {
  try {
    const sid = req.params.id;
    const { answers } = req.body;
    // answers: { question_id: string, answer: string }[]
    if (!Array.isArray(answers) || answers.length === 0) {
      return res.status(400).json({ error: "answers array is required" });
    }

    // Get original scenario input
    const sRes = await pool.query("SELECT nl_input FROM scenarios WHERE scenario_id = $1", [sid]);
    if (sRes.rows.length === 0) return res.status(404).json({ error: "Scenario not found" });

    // Build an enriched input that combines the original query with the user's answers
    const originalInput = sRes.rows[0].nl_input;
    const answerContext = answers
      .map((a: { question_id: string; answer: string }) => `- ${a.question_id}: ${a.answer}`)
      .join("\n");
    const enrichedInput = `${originalInput}\n\nAdditional context from user:\n${answerContext}`;

    // Re-parse with the enriched input
    const parseResult = await parseScenario(enrichedInput);

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

      const scenarioValue = (p.magnitude != null && !isNaN(Number(p.magnitude))) ? Number(p.magnitude) : 0;
      paramsWithMapping.push({ name: p.name, mapped_variable_id: variableId, scenario_value: scenarioValue, confidence: p.confidence });
      await pool.query(
        `INSERT INTO scenario_parameters (scenario_id, extracted_name, mapped_variable_id, scenario_value, confidence_score, status)
         VALUES ($1, $2, $3, $4, $5, 'pending')`,
        [sid, p.name, variableId, scenarioValue, p.confidence]
      );
    }

    await logAudit(sid, "refined", { answer_count: answers.length, new_param_count: parseResult.parameters.length });

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
    console.error(e);
    return res.status(500).json({ error: "Failed to refine scenario" });
  }
});

scenariosRouter.get("/", async (_req, res) => {
  try {
    const r = await pool.query(
      `SELECT scenario_id, name, nl_input, status, created_at, updated_at
       FROM scenarios ORDER BY created_at DESC LIMIT 100`
    );
    return res.json({ scenarios: r.rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Failed to list scenarios" });
  }
});

scenariosRouter.get("/:id", async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT scenario_id, name, description, nl_input, status, model_version_hash, base_case_id, created_at, updated_at
       FROM scenarios WHERE scenario_id = $1`,
      [req.params.id]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: "Scenario not found" });
    return res.json(r.rows[0]);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Failed to get scenario" });
  }
});

scenariosRouter.get("/:id/parameters", async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT parameter_id, extracted_name, mapped_variable_id, base_value, scenario_value, confidence_score, status
       FROM scenario_parameters WHERE scenario_id = $1 ORDER BY created_at`,
      [req.params.id]
    );
    return res.json({ parameters: r.rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Failed to get parameters" });
  }
});

scenariosRouter.put("/:id/parameters/:paramId", async (req, res) => {
  try {
    const { scenario_value, status, override_reason } = req.body;

    // Record override history if value is changing
    if (scenario_value !== undefined) {
      const prev = await pool.query(
        "SELECT scenario_value FROM scenario_parameters WHERE scenario_id = $1 AND parameter_id = $2",
        [req.params.id, req.params.paramId]
      );
      if (prev.rows.length > 0) {
        const userId = await getDefaultUserId();
        await pool.query(
          `INSERT INTO parameter_override_history (parameter_id, previous_value, new_value, changed_by, reason)
           VALUES ($1, $2, $3, $4, $5)`,
          [req.params.paramId, prev.rows[0].scenario_value, Number(scenario_value), userId, override_reason || null]
        );
      }
    }

    const updates: string[] = [];
    const values: unknown[] = [];
    let i = 1;
    if (scenario_value !== undefined) {
      updates.push(`scenario_value = $${i++}`);
      values.push(Number(scenario_value));
      updates.push(`is_override = TRUE`);
      if (override_reason) {
        updates.push(`override_reason = $${i++}`);
        values.push(override_reason);
      }
    }
    if (status !== undefined && ["pending", "accepted", "rejected", "modified"].includes(status)) {
      updates.push(`status = $${i++}`);
      values.push(status);
    }
    if (updates.length === 0) return res.status(400).json({ error: "No updates provided" });
    values.push(req.params.id, req.params.paramId);
    const r = await pool.query(
      `UPDATE scenario_parameters SET ${updates.join(", ")} WHERE scenario_id = $${i++} AND parameter_id = $${i} RETURNING parameter_id, extracted_name, mapped_variable_id, scenario_value, status, is_override, override_reason`,
      values
    );
    if (r.rows.length === 0) return res.status(404).json({ error: "Parameter not found" });
    await logAudit(req.params.id, "parameter_updated", { parameter_id: req.params.paramId, new_value: scenario_value, status });
    return res.json(r.rows[0]);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Failed to update parameter" });
  }
});

scenariosRouter.post("/:id/parameters/:paramId/reject", async (req, res) => {
  try {
    const r = await pool.query(
      `UPDATE scenario_parameters SET status = 'rejected' WHERE scenario_id = $1 AND parameter_id = $2 RETURNING parameter_id`,
      [req.params.id, req.params.paramId]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: "Parameter not found" });
    return res.json({ parameter_id: r.rows[0].parameter_id, status: "rejected" });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Failed to reject parameter" });
  }
});

// ── Approval gate ──
scenariosRouter.post("/:id/approve", requireRole("approver"), async (req, res) => {
  try {
    const sid = req.params.id;
    const params = await pool.query(
      "SELECT status FROM scenario_parameters WHERE scenario_id = $1",
      [sid]
    );
    if (params.rows.length === 0) return res.status(400).json({ error: "No parameters to approve" });
    const hasAccepted = params.rows.some((p: { status: string }) => p.status === "accepted");
    if (!hasAccepted) {
      return res.status(400).json({ error: "At least one parameter must be accepted before approval" });
    }
    const userId = await getDefaultUserId();
    await pool.query(
      `UPDATE scenarios SET status = 'approved', approved_at = NOW(), approved_by = $2 WHERE scenario_id = $1`,
      [sid, userId]
    );
    await logAudit(sid, "approved", { approved_by: userId });
    return res.json({ scenario_id: sid, status: "approved" });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Failed to approve scenario" });
  }
});

// ── Run simulation (requires approval) ──
scenariosRouter.post("/:id/run", async (req, res) => {
  try {
    const sid = req.params.id;
    const sRes = await pool.query("SELECT status FROM scenarios WHERE scenario_id = $1", [sid]);
    if (sRes.rows.length === 0) return res.status(404).json({ error: "Scenario not found" });
    if (sRes.rows[0].status !== "approved" && sRes.rows[0].status !== "completed") {
      return res.status(400).json({ error: "Scenario must be approved before running. Accept parameters and click Approve first." });
    }
    const output = await runSimulation(sid);
    await logAudit(sid, "simulation_run", { metrics: Object.keys(output.pl) });
    return res.json({ scenario_id: sid, ...output });
  } catch (e) {
    const msg = (e as Error).message;
    if (msg === "Scenario not found") return res.status(404).json({ error: msg });
    console.error(e);
    return res.status(500).json({ error: "Simulation failed" });
  }
});

// ── Outputs ──
scenariosRouter.get("/:id/outputs", async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT output_id, output_type, output_data, narrative_summary, created_at
       FROM scenario_outputs WHERE scenario_id = $1 ORDER BY created_at DESC`,
      [req.params.id]
    );
    return res.json({ outputs: r.rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Failed to get outputs" });
  }
});

// ── Narrative ──
scenariosRouter.post("/:id/narrative", async (req, res) => {
  try {
    const sid = req.params.id;
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
    console.error(e);
    return res.status(500).json({ error: "Failed to generate narrative" });
  }
});

// ── Business Analysis Agent ("So What?") ──
scenariosRouter.post("/:id/business-analysis", async (req, res) => {
  try {
    const sid = req.params.id;
    const sRes = await pool.query("SELECT status FROM scenarios WHERE scenario_id = $1", [sid]);
    if (sRes.rows.length === 0) return res.status(404).json({ error: "Scenario not found" });

    const analysis = await generateBusinessAnalysis(sid);
    await logAudit(sid, "business_analysis", { headline: analysis.headline.slice(0, 100) });

    // Store the analysis result
    await pool.query(
      `INSERT INTO scenario_outputs (scenario_id, output_type, output_data) VALUES ($1, 'business_analysis', $2)`,
      [sid, JSON.stringify(analysis)]
    );

    return res.json(analysis);
  } catch (e) {
    const msg = (e as Error).message;
    if (msg === "Scenario not found") return res.status(404).json({ error: msg });
    console.error(e);
    return res.status(500).json({ error: "Business analysis failed" });
  }
});

// (compare route registered at top of file before /:id routes)
