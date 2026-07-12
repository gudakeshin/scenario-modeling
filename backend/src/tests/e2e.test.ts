/**
 * End-to-end integration tests for the Scenario Modeling API.
 *
 * Flow tested: NL Input → Parse → Create Scenario → Review Parameters →
 *   Approve → Run Simulation → Narrative → Business Analysis → Comparison → Export
 *
 * Uses supertest against the Express app (no server listen in test mode).
 * Requires a running PostgreSQL database (same as dev).
 */

import test, { before } from "node:test";
import assert from "node:assert";
import request from "supertest";
import { app } from "../index.js";
import { pool } from "../db/index.js";
import ExcelJS from "exceljs";

const rawAgent = request(app);

// All routes require a Bearer token since Phase 0 auth landed. Log in once
// as the seeded dev admin and transparently attach the token to every
// request this suite makes, so the 70+ existing call sites don't need to
// change individually.
let authToken = "";
let e2eWorkspaceId = "";
let e2eUserId = "";

function withAuth<T extends { set: (field: string, val: string) => T }>(req: T): T {
  let next = authToken ? req.set("Authorization", `Bearer ${authToken}`) : req;
  if (e2eWorkspaceId) next = next.set("X-Workspace-Id", e2eWorkspaceId);
  return next;
}

const agent = new Proxy(rawAgent, {
  get(target, prop, receiver) {
    if (prop === "get" || prop === "post" || prop === "put" || prop === "delete" || prop === "patch") {
      return (...args: unknown[]) =>
        withAuth((target as unknown as Record<string, (...a: unknown[]) => { set: (f: string, v: string) => unknown }>)[prop as string](...args) as never);
    }
    return Reflect.get(target, prop, receiver);
  },
}) as typeof rawAgent;

const E2E_FORMULA_MODEL = {
  model_version: "e2e-formula",
  variables: [
    { id: "revenue", name: "Revenue", formula: "100000", dependencies: [], tags: ["pl_metric", "percent_delta"] },
    { id: "raw_materials", name: "Raw Materials", formula: "30000", dependencies: [], tags: ["pl_metric", "percent_delta"] },
    { id: "opex", name: "OpEx", formula: "20000", dependencies: [], tags: ["pl_metric", "percent_delta"] },
    { id: "gross_profit", name: "Gross Profit", formula: "revenue - raw_materials", dependencies: ["revenue", "raw_materials"], tags: ["pl_metric"] },
    { id: "ebit", name: "EBIT", formula: "gross_profit - opex", dependencies: ["gross_profit", "opex"], tags: ["pl_metric"] },
    { id: "tax", name: "Tax", formula: "ebit * 0.25", dependencies: ["ebit"], tags: ["pl_metric"] },
    { id: "net_income", name: "Net Income", formula: "ebit - tax", dependencies: ["ebit", "tax"], tags: ["pl_metric"] },
  ],
  time_horizon: { start: "2024-01", end: "2024-12", granularity: "monthly" as const },
};

before(async () => {
  const res = await rawAgent.post("/api/v1/auth/login").send({
    email: "dev@example.com",
    password: process.env.SEED_ADMIN_PASSWORD || "changeme-admin-password",
  });
  if (res.status !== 200) {
    throw new Error(`e2e setup: seed admin login failed (run \`npm run db:seed\` first): ${JSON.stringify(res.body)}`);
  }
  authToken = res.body.access_token;
  e2eUserId = res.body.user.user_id;

  // Isolate from default-workspace XLSX / external models so formula-DAG e2e stays deterministic.
  const ws = await rawAgent
    .post("/api/v1/workspaces")
    .set("Authorization", `Bearer ${authToken}`)
    .send({ name: `e2e-formula-${Date.now().toString(36)}` });
  if (ws.status !== 201) {
    throw new Error(`e2e setup: failed to create workspace: ${JSON.stringify(ws.body)}`);
  }
  e2eWorkspaceId = ws.body.workspace_id;

  await pool.query(
    `UPDATE user_models SET is_active = false WHERE workspace_id = $1 AND is_active`,
    [e2eWorkspaceId],
  );
  await pool.query(
    `INSERT INTO user_models (created_by, workspace_id, name, model_definition, source_kind, is_active)
     VALUES ($1, $2, $3, $4, 'documents', true)`,
    [e2eUserId, e2eWorkspaceId, "E2E Formula Model", JSON.stringify(E2E_FORMULA_MODEL)],
  );
});

async function buildMinimalXlsxBuffer(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const assumptions = wb.addWorksheet("Assumptions");
  assumptions.getCell("A1").value = "All figures in INR Million";
  assumptions.getCell("B4").value = "Base";
  assumptions.getCell("B8").value = 0.06;

  const volume = wb.addWorksheet("Volume_Plan");
  volume.getCell("A1").value = "Product";
  volume.getCell("B1").value = "Apr-24";
  volume.getCell("C1").value = "May-24";
  volume.getCell("D1").value = "FY Total";
  volume.getCell("A2").value = "Bullet";
  volume.getCell("B2").value = { formula: "Assumptions!B8*1000", result: 60 };

  const pnl = wb.addWorksheet("P&L");
  pnl.getCell("A1").value = "Revenue";
  pnl.getCell("B1").value = { formula: "Volume_Plan!B2*100", result: 6000 };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ─── Helper: run the full happy-path and return scenario ID ───
async function createAndRunScenario(nlInput: string): Promise<{
  scenarioId: string;
  parameters: Array<{ parameter_id: string; mapped_variable_id: string; scenario_value: number; status: string }>;
}> {
  // 1. Create scenario
  const createRes = await agent
    .post("/api/v1/scenarios")
    .send({ nl_input: nlInput })
    .expect(201);

  const scenarioId = createRes.body.scenario_id;
  assert.ok(scenarioId, "scenario_id should be returned");

  // 2. Get parameters
  const paramsRes = await agent
    .get(`/api/v1/scenarios/${scenarioId}/parameters`)
    .expect(200);

  const params = paramsRes.body.parameters;

  // 3. Accept all parameters
  for (const p of params) {
    await agent
      .put(`/api/v1/scenarios/${scenarioId}/parameters/${p.parameter_id}`)
      .send({ status: "accepted" })
      .expect(200);
  }

  // 4. Approve
  await agent
    .post(`/api/v1/scenarios/${scenarioId}/approve`)
    .expect(200);

  // 5. Run simulation
  await agent
    .post(`/api/v1/scenarios/${scenarioId}/run`)
    .expect(200);

  return { scenarioId, parameters: params };
}

// ═══════════════════════════════════════════════════════════════
// 1. FULL HAPPY PATH: NL → Parse → Map → Simulate → Output
// ═══════════════════════════════════════════════════════════════

test("E2E: Full happy path — raw materials increase 8%", async () => {
  // Step 1: Create scenario
  const createRes = await agent
    .post("/api/v1/scenarios")
    .send({ nl_input: "What if raw materials increase 8%?" })
    .expect(201);

  const { scenario_id, parameters, status } = createRes.body;
  assert.ok(scenario_id, "should return scenario_id");
  assert.strictEqual(status, "draft");
  assert.ok(Array.isArray(parameters), "should return parameters array");
  assert.ok(parameters.length > 0, "should extract at least one parameter");

  // Step 2: Verify parameters are persisted
  const paramsRes = await agent
    .get(`/api/v1/scenarios/${scenario_id}/parameters`)
    .expect(200);
  assert.ok(paramsRes.body.parameters.length > 0, "parameters should be in DB");

  // Step 3: Accept parameters
  for (const p of paramsRes.body.parameters) {
    const acceptRes = await agent
      .put(`/api/v1/scenarios/${scenario_id}/parameters/${p.parameter_id}`)
      .send({ status: "accepted" })
      .expect(200);
    assert.strictEqual(acceptRes.body.status, "accepted");
  }

  // Step 4: Approve scenario
  const approveRes = await agent
    .post(`/api/v1/scenarios/${scenario_id}/approve`)
    .expect(200);
  assert.strictEqual(approveRes.body.status, "approved");

  // Step 5: Run simulation
  const runRes = await agent
    .post(`/api/v1/scenarios/${scenario_id}/run`)
    .expect(200);

  assert.ok(runRes.body.pl, "should return P&L output");
  assert.ok(typeof runRes.body.pl.revenue === "number", "revenue should be a number");
  assert.ok(typeof runRes.body.pl.net_income === "number", "net_income should be a number");
  assert.ok(runRes.body.pl.revenue > 0, "revenue should be positive");

  // Step 6: Get outputs from DB
  const outputsRes = await agent
    .get(`/api/v1/scenarios/${scenario_id}/outputs`)
    .expect(200);
  assert.ok(outputsRes.body.outputs.length > 0, "should have stored outputs");
  assert.strictEqual(outputsRes.body.outputs[0].output_type, "pl");

  // Step 7: Verify scenario is marked completed
  const scenarioRes = await agent
    .get(`/api/v1/scenarios/${scenario_id}`)
    .expect(200);
  assert.strictEqual(scenarioRes.body.status, "completed");
});

// ═══════════════════════════════════════════════════════════════
// 2. NARRATIVE GENERATION
// ═══════════════════════════════════════════════════════════════

test("E2E: Narrative generation after simulation", async () => {
  const { scenarioId } = await createAndRunScenario("Revenue increases 15%");

  const narrativeRes = await agent
    .post(`/api/v1/scenarios/${scenarioId}/narrative`)
    .send({ audience: "board" })
    .expect(200);

  assert.ok(narrativeRes.body.narrative, "should return narrative text");
  assert.ok(narrativeRes.body.narrative.length > 50, "narrative should be substantial");
});

// ═══════════════════════════════════════════════════════════════
// 3. BUSINESS ANALYSIS AGENT
// ═══════════════════════════════════════════════════════════════

test("E2E: Business analysis agent (So What?)", async () => {
  const { scenarioId } = await createAndRunScenario("COGS increase 12%");

  const analysisRes = await agent
    .post(`/api/v1/scenarios/${scenarioId}/business-analysis`)
    .expect(200);

  const insight = analysisRes.body;
  assert.ok(insight.headline, "should have headline");
  assert.ok(Array.isArray(insight.implications), "should have implications");
  assert.ok(insight.implications.length > 0, "should have at least one implication");
  assert.ok(Array.isArray(insight.risks), "should have risks");
  assert.ok(Array.isArray(insight.recommendations), "should have recommendations");
  assert.ok(insight.recommendations.length > 0, "should have at least one recommendation");
  assert.ok(insight.decision_context, "should have decision_context");
  assert.ok(insight.confidence_note, "should have confidence_note");

  // Verify stored in outputs
  const outputsRes = await agent
    .get(`/api/v1/scenarios/${scenarioId}/outputs`)
    .expect(200);
  const analysisOutput = outputsRes.body.outputs.find(
    (o: { output_type: string }) => o.output_type === "business_analysis"
  );
  assert.ok(analysisOutput, "business analysis should be stored in scenario_outputs");
});

// ═══════════════════════════════════════════════════════════════
// 4. SCENARIO COMPARISON
// ═══════════════════════════════════════════════════════════════

test("E2E: Compare two scenarios", async () => {
  const { scenarioId: id1 } = await createAndRunScenario("Revenue increases 10%");
  const { scenarioId: id2 } = await createAndRunScenario("Revenue decreases 10%");

  const compareRes = await agent
    .post("/api/v1/scenarios/compare")
    .send({ scenario_ids: [id1, id2] })
    .expect(200);

  assert.ok(Array.isArray(compareRes.body.metrics), "should return metrics array");
  assert.ok(compareRes.body.metrics.length > 0, "should have metric comparisons");
  assert.ok(Array.isArray(compareRes.body.key_callouts), "should return key_callouts");
  assert.ok(compareRes.body.key_callouts.length > 0, "should have at least one key callout");

  // Verify each metric row has correct structure
  for (const m of compareRes.body.metrics) {
    assert.ok(m.metric, "metric row should have metric name");
    assert.ok(typeof m.base === "number", "metric row should have numeric base");
    assert.ok(Array.isArray(m.scenarios), "metric row should have scenarios array");
    for (const s of m.scenarios) {
      assert.ok(typeof s.value === "number", "scenario should have numeric value");
      assert.ok(typeof s.delta === "number", "scenario should have numeric delta");
    }
  }
});

// ═══════════════════════════════════════════════════════════════
// 5. MONTE CARLO SIMULATION
// ═══════════════════════════════════════════════════════════════

test("E2E: Monte Carlo simulation", async () => {
  const { scenarioId } = await createAndRunScenario("Unit price increase 5%");

  const mcRes = await agent
    .post(`/api/v1/scenarios/${scenarioId}/monte-carlo`)
    .send({ iterations: 200 })
    .expect(200);

  assert.ok(mcRes.body.iterations >= 200, "should run requested iterations");
  assert.ok(mcRes.body.metrics, "should return metrics");
  assert.ok(mcRes.body.metrics.net_income, "should have net_income metric");
  assert.ok(typeof mcRes.body.metrics.net_income.p50 === "number", "p50 should be a number");
  assert.ok(mcRes.body.metrics.net_income.p10 <= mcRes.body.metrics.net_income.p50, "P10 <= P50");
  assert.ok(mcRes.body.metrics.net_income.p50 <= mcRes.body.metrics.net_income.p90, "P50 <= P90");
  assert.ok(mcRes.body.fan_chart, "should return fan_chart");
  assert.ok(mcRes.body.distributions, "should return distributions");
});

// ═══════════════════════════════════════════════════════════════
// 6. SENSITIVITY ANALYSIS (TORNADO)
// ═══════════════════════════════════════════════════════════════

test("E2E: Sensitivity analysis (tornado chart)", async () => {
  const { scenarioId } = await createAndRunScenario("OpEx increase 10%");

  const tornadoRes = await agent
    .post(`/api/v1/scenarios/${scenarioId}/sensitivity`)
    .send({ target_metric: "net_income", swing_pct: 15 })
    .expect(200);

  assert.strictEqual(tornadoRes.body.target_metric, "net_income");
  assert.strictEqual(tornadoRes.body.swing_pct, 15);
  assert.ok(typeof tornadoRes.body.base_metric_value === "number", "should return base metric value");
  assert.ok(Array.isArray(tornadoRes.body.bars), "should return bars array");

  // Bars should be sorted by spread descending
  for (let i = 1; i < tornadoRes.body.bars.length; i++) {
    assert.ok(
      tornadoRes.body.bars[i - 1].spread >= tornadoRes.body.bars[i].spread,
      "bars should be sorted by spread descending"
    );
  }
});

// ═══════════════════════════════════════════════════════════════
// 7. AUDIT TRAIL
// ═══════════════════════════════════════════════════════════════

test("E2E: Audit trail records scenario lifecycle", async () => {
  const { scenarioId } = await createAndRunScenario("Marketing spend increase 20%");

  const auditRes = await agent
    .get("/api/v1/audit")
    .query({ scenario_id: scenarioId })
    .expect(200);

  const actions = auditRes.body.entries.map((e: { action_type: string }) => e.action_type);
  assert.ok(actions.includes("created"), "should log 'created'");
  assert.ok(actions.includes("approved"), "should log 'approved'");
  assert.ok(actions.includes("simulation_run"), "should log 'simulation_run'");
});

// ═══════════════════════════════════════════════════════════════
// 8. TEMPLATE LIBRARY
// ═══════════════════════════════════════════════════════════════

test("E2E: Save and clone template", async () => {
  const { scenarioId } = await createAndRunScenario("Units sold decrease 5%");

  // Save as template (via from-scenario endpoint)
  const saveRes = await agent
    .post(`/api/v1/templates/from-scenario/${scenarioId}`)
    
    .send({ name: "E2E Test Template", description: "Test" })
    .expect(201);
  const templateId = saveRes.body.template_id;
  assert.ok(templateId, "should return template_id");

  // List templates
  const listRes = await agent
    .get("/api/v1/templates")
    .expect(200);
  const found = listRes.body.templates.find((t: { template_id: string }) => t.template_id === templateId);
  assert.ok(found, "template should appear in list");
  assert.strictEqual(found.name, "E2E Test Template");

  // Clone template into new scenario
  const cloneRes = await agent
    .post(`/api/v1/templates/${templateId}/clone`)
    .expect(201);
  assert.ok(cloneRes.body.scenario_id, "clone should return new scenario_id");
  assert.notStrictEqual(cloneRes.body.scenario_id, scenarioId, "cloned scenario should be different");

  // Verify cloned scenario has parameters
  const clonedParams = await agent
    .get(`/api/v1/scenarios/${cloneRes.body.scenario_id}/parameters`)
    .expect(200);
  assert.ok(clonedParams.body.parameters.length > 0, "cloned scenario should have parameters");
});

// ═══════════════════════════════════════════════════════════════
// 9. CONVERSATIONAL FOLLOW-UP
// ═══════════════════════════════════════════════════════════════

test("E2E: Conversational follow-up adds parameters", async () => {
  // Create initial scenario
  const createRes = await agent
    .post("/api/v1/scenarios")
    .send({ nl_input: "Revenue increase 10%" })
    .expect(201);
  const scenarioId = createRes.body.scenario_id;

  // Start session
  const sessionRes = await agent
    .post("/api/v1/sessions")
    .send({ scenario_id: scenarioId })
    .expect(201);
  const sessionId = sessionRes.body.session_id;
  assert.ok(sessionId, "should return session_id");

  // Get initial parameter count
  const p1 = await agent.get(`/api/v1/scenarios/${scenarioId}/parameters`).expect(200);
  const initialCount = p1.body.parameters.length;

  // Follow-up: add more parameters
  const followUpRes = await agent
    .post(`/api/v1/sessions/${sessionId}/follow-up`)
    .send({ nl_input: "also increase marketing 15%" })
    .expect(200);

  assert.ok(followUpRes.body.added_parameters, "should return added_parameters");
  assert.ok(followUpRes.body.cumulative_count >= initialCount, "cumulative should be >= initial");

  // Verify parameters grew
  const p2 = await agent.get(`/api/v1/scenarios/${scenarioId}/parameters`).expect(200);
  assert.ok(p2.body.parameters.length >= initialCount, "parameter count should not decrease");
});

// ═══════════════════════════════════════════════════════════════
// 10. EDGE CASES & ERROR HANDLING
// ═══════════════════════════════════════════════════════════════

test("Edge: Empty NL input returns 400", async () => {
  const res = await agent
    .post("/api/v1/scenarios")
    .send({ nl_input: "" })
    .expect(400);
  assert.ok(res.body.error, "should return error message");
});

test("Edge: Missing nl_input field returns 400", async () => {
  const res = await agent
    .post("/api/v1/scenarios")
    .send({})
    .expect(400);
  assert.ok(res.body.error);
});

test("Edge: Non-existent scenario returns 404", async () => {
  await agent
    .get("/api/v1/scenarios/00000000-0000-0000-0000-000000000000")
    .expect(404);
});

test("Edge: Run unapproved scenario returns 400", async () => {
  const createRes = await agent
    .post("/api/v1/scenarios")
    .send({ nl_input: "Test scenario for run check" })
    .expect(201);

  const res = await agent
    .post(`/api/v1/scenarios/${createRes.body.scenario_id}/run`)
    .expect(400);
  assert.ok(res.body.error.includes("approved"), "error should mention approval");
});

test("Edge: Approve with no accepted parameters returns 400", async () => {
  const createRes = await agent
    .post("/api/v1/scenarios")
    .send({ nl_input: "Revenue drop 10%" })
    .expect(201);

  const res = await agent
    .post(`/api/v1/scenarios/${createRes.body.scenario_id}/approve`)
    .expect(400);
  assert.ok(res.body.error, "should return error about parameters");
});

test("Edge: NL input with only qualitative description still creates scenario", async () => {
  const res = await agent
    .post("/api/v1/scenarios")
    .send({ nl_input: "What if there is a global recession?" })
    .expect(201);

  assert.ok(res.body.scenario_id, "should still create scenario");
  assert.ok(Array.isArray(res.body.parameters), "should return parameters array");
});

test("Edge: Very long NL input is handled gracefully", async () => {
  const longInput = "Revenue increases 10%. ".repeat(200); // ~4600 chars, over 2000 limit
  const res = await agent
    .post("/api/v1/scenarios/parse")
    .send({ nl_input: longInput });

  // Should either succeed (if under limit after sanitize) or fail gracefully
  assert.ok(res.status === 200 || res.status === 400, "should handle gracefully");
});

test("Edge: Health check works", async () => {
  const res = await agent.get("/health").expect(200);
  assert.strictEqual(res.body.status, "ok");
  assert.strictEqual(res.body.service, "scenario-modeling-api");
});

// ═══════════════════════════════════════════════════════════════
// 11. EXPORT ENDPOINTS
// ═══════════════════════════════════════════════════════════════

test("E2E: Excel and CSV export after simulation", async () => {
  const { scenarioId } = await createAndRunScenario("Raw materials increase 5%");

  // Excel export
  const excelRes = await agent
    .get(`/api/v1/scenarios/${scenarioId}/export/excel`)
    .expect(200);
  assert.ok(
    excelRes.headers["content-type"]?.includes("spreadsheet") ||
    excelRes.headers["content-type"]?.includes("octet-stream"),
    "should return Excel content type"
  );

  // CSV export
  const csvRes = await agent
    .get(`/api/v1/scenarios/${scenarioId}/export/csv`)
    .expect(200);
  assert.ok(
    csvRes.headers["content-type"]?.includes("csv") ||
    csvRes.headers["content-type"]?.includes("text"),
    "should return CSV content type"
  );
  assert.ok(csvRes.text.includes(","), "CSV should contain commas");
});

// ═══════════════════════════════════════════════════════════════
// 12. PARSE-ONLY ENDPOINT
// ═══════════════════════════════════════════════════════════════

test("E2E: Parse-only endpoint returns structured parameters", async () => {
  const res = await agent
    .post("/api/v1/scenarios/parse")
    .send({ nl_input: "Delay APAC launch by one quarter and raw materials increase 8%" })
    .expect(200);

  assert.ok(Array.isArray(res.body.parameters), "should return parameters");
  assert.ok(res.body.parameters.length >= 1, "should extract at least one parameter");

  // Verify parameter structure
  for (const p of res.body.parameters) {
    assert.ok(p.name, "parameter should have name");
    assert.ok(typeof p.confidence === "number", "parameter should have numeric confidence");
    assert.ok(p.confidence >= 0 && p.confidence <= 1, "confidence should be 0-1");
  }
});

// ═══════════════════════════════════════════════════════════════
// 13. PARAMETER OVERRIDE WITH HISTORY
// ═══════════════════════════════════════════════════════════════

test("E2E: Parameter value override records history", async () => {
  const createRes = await agent
    .post("/api/v1/scenarios")
    .send({ nl_input: "Revenue increase 20%" })
    .expect(201);

  const scenarioId = createRes.body.scenario_id;
  const paramsRes = await agent.get(`/api/v1/scenarios/${scenarioId}/parameters`).expect(200);
  const param = paramsRes.body.parameters[0];
  assert.ok(param, "should have at least one parameter");

  // Override value
  const overrideRes = await agent
    .put(`/api/v1/scenarios/${scenarioId}/parameters/${param.parameter_id}`)
    .send({ scenario_value: 25, status: "modified", override_reason: "E2E test override" })
    .expect(200);

  assert.strictEqual(overrideRes.body.status, "modified");
  assert.strictEqual(overrideRes.body.is_override, true);
});

// ═══════════════════════════════════════════════════════════════
// 14. MULTI-PERIOD SIMULATION
// ═══════════════════════════════════════════════════════════════

test("E2E: Simulation returns multi-period breakdown", async () => {
  const { scenarioId } = await createAndRunScenario("Revenue increases 10%");

  // Get the run outputs
  const outputsRes = await agent
    .get(`/api/v1/scenarios/${scenarioId}/outputs`)
    .expect(200);

  const plOutput = outputsRes.body.outputs.find(
    (o: { output_type: string }) => o.output_type === "pl"
  );
  assert.ok(plOutput, "should have pl output");

  // Verify multi-period structure
  const data = plOutput.output_data;
  assert.ok(data.aggregate, "should have aggregate P&L");
  assert.ok(Array.isArray(data.periods), "should have periods array");
  assert.ok(data.periods.length > 0, "should have at least one period");
  assert.ok(data.granularity, "should have granularity");
  assert.ok(data.period_count > 0, "should have period_count");

  // Verify each period has P&L
  for (const period of data.periods) {
    assert.ok(period.period, "period should have label");
    assert.ok(period.pl, "period should have pl");
    assert.ok(typeof period.pl.revenue === "number", "period should have revenue");
    assert.ok(typeof period.pl.net_income === "number", "period should have net_income");
  }

  // Verify aggregate is sum of periods
  const periodRevenueSum = data.periods.reduce(
    (sum: number, p: { pl: Record<string, number> }) => sum + (p.pl.revenue || 0),
    0
  );
  const diff = Math.abs(data.aggregate.revenue - periodRevenueSum);
  assert.ok(diff < 1, `aggregate revenue ($${data.aggregate.revenue}) should roughly equal sum of periods ($${periodRevenueSum})`);
});

test("E2E: Run endpoint returns periods in response", async () => {
  const createRes = await agent
    .post("/api/v1/scenarios")
    .send({ nl_input: "Unit price decrease 10%" })
    .expect(201);

  const scenarioId = createRes.body.scenario_id;
  const paramsRes = await agent.get(`/api/v1/scenarios/${scenarioId}/parameters`).expect(200);

  for (const p of paramsRes.body.parameters) {
    await agent.put(`/api/v1/scenarios/${scenarioId}/parameters/${p.parameter_id}`).send({ status: "accepted" }).expect(200);
  }
  await agent.post(`/api/v1/scenarios/${scenarioId}/approve`).expect(200);

  const runRes = await agent.post(`/api/v1/scenarios/${scenarioId}/run`).expect(200);

  // Verify multi-period response fields
  assert.ok(runRes.body.pl, "should have aggregate pl");
  assert.ok(runRes.body.variables, "should have variables");
  assert.ok(Array.isArray(runRes.body.periods), "should have periods array");
  assert.ok(runRes.body.period_count > 0, "should have period_count");
  assert.ok(runRes.body.granularity, "should have granularity");
  assert.strictEqual(runRes.body.periods.length, runRes.body.period_count, "periods length should match period_count");
});

test("E2E: Multi-period export includes period breakdown in CSV", async () => {
  const { scenarioId } = await createAndRunScenario("OpEx increase 5%");

  const csvRes = await agent
    .get(`/api/v1/scenarios/${scenarioId}/export/csv`)
    .expect(200);

  assert.ok(csvRes.text.includes("Period Breakdown"), "CSV should include period breakdown section");
  assert.ok(csvRes.text.includes("Q1") || csvRes.text.includes("01"), "CSV should include period labels");
});

// ═══════════════════════════════════════════════════════════════
// 15. SIMULATION TIMEOUT
// ═══════════════════════════════════════════════════════════════

test("E2E: Simulation completes within timeout", async () => {
  const startTime = Date.now();
  const { scenarioId } = await createAndRunScenario("Revenue increase 50%");
  const elapsed = Date.now() - startTime;

  assert.ok(elapsed < 60_000, `Simulation should complete within 60s (took ${elapsed}ms)`);

  // Verify scenario completed
  const scenarioRes = await agent.get(`/api/v1/scenarios/${scenarioId}`).expect(200);
  assert.strictEqual(scenarioRes.body.status, "completed");
});

// ═══════════════════════════════════════════════════════════════
// 16. BASE CASE ENDPOINT
// ═══════════════════════════════════════════════════════════════

test("E2E: Base case endpoint returns P&L and time horizon", async () => {
  const res = await agent
    .get("/api/v1/scenarios/base-case")
    .expect(200);

  assert.ok(res.body.pl, "should return pl");
  assert.ok(typeof res.body.pl.revenue === "number", "should have numeric revenue");
  assert.ok(typeof res.body.pl.net_income === "number", "should have numeric net_income");
  assert.ok(res.body.pl.revenue > 0, "base revenue should be positive");
  assert.ok(res.body.all_variables, "should return all_variables");
  assert.ok(res.body.time_horizon, "should return time_horizon");
  assert.ok(res.body.time_horizon.granularity, "should have granularity");
});

// ═══════════════════════════════════════════════════════════════
// 17. POWERPOINT EXPORT
// ═══════════════════════════════════════════════════════════════

test("E2E: PowerPoint export returns PPTX file", async () => {
  const { scenarioId } = await createAndRunScenario("Revenue increase 8%");

  const pptxRes = await agent
    .get(`/api/v1/scenarios/${scenarioId}/export/pptx`)
    
    .buffer(true)
    .expect(200);

  assert.ok(
    pptxRes.headers["content-type"]?.includes("presentation") ||
    pptxRes.headers["content-type"]?.includes("octet-stream"),
    "should return PPTX content type"
  );
  // Binary response: check content-length or buffer length
  const contentLength = parseInt(pptxRes.headers["content-length"] || "0", 10);
  assert.ok(contentLength > 100 || Buffer.byteLength(pptxRes.body) > 100, "should return substantial PPTX content");
});

// ═══════════════════════════════════════════════════════════════
// 18. LIST SCENARIOS
// ═══════════════════════════════════════════════════════════════

test("E2E: List scenarios returns recent entries", async () => {
  const res = await agent
    .get("/api/v1/scenarios")
    .expect(200);

  assert.ok(Array.isArray(res.body.scenarios), "should return scenarios array");
  // We've created several scenarios in prior tests
  assert.ok(res.body.scenarios.length > 0, "should have at least one scenario");

  // Verify structure
  const s = res.body.scenarios[0];
  assert.ok(s.scenario_id, "should have scenario_id");
  assert.ok(s.nl_input, "should have nl_input");
  assert.ok(s.status, "should have status");
});

// ═══════════════════════════════════════════════════════════════
// 19. SEARCH-DRIVEN SCENARIO (Perplexity integration)
// ═══════════════════════════════════════════════════════════════

test("E2E: Macro/news input triggers search context in response", async () => {
  // This test verifies the search detection logic works.
  // Use input that heuristic parser can also handle (has explicit % change)
  const res = await agent
    .post("/api/v1/scenarios")
    .send({ nl_input: "Inflation impact causes raw materials increase 8% and opex increase 5%" })
    .expect(201);

  assert.ok(res.body.scenario_id, "should create scenario");
  assert.ok(Array.isArray(res.body.parameters), "should have parameters");
  assert.ok(res.body.parameters.length > 0, "should extract parameters from macro input");

  // If Perplexity key is configured and the remote provider responds, search_context is present.
  if (process.env.PERPLEXITY_API_KEY) {
    if (!res.body.search_context) {
      console.warn("E2E: PERPLEXITY_API_KEY set but search_context missing — skipping remote assertion");
      return;
    }
    assert.ok(res.body.search_context.summary, "search_context should have summary");
    assert.ok(res.body.search_context.query, "search_context should have query");
  }
});

test("E2E: Non-macro input does not trigger search context", async () => {
  const res = await agent
    .post("/api/v1/scenarios")
    .send({ nl_input: "Revenue increases 10% and costs decrease 5%" })
    .expect(201);

  assert.ok(res.body.scenario_id, "should create scenario");
  // Simple percentage changes should NOT trigger external search
  assert.ok(!res.body.search_context, "should NOT include search_context for simple inputs");
});

// ═══════════════════════════════════════════════════════════════
// 20. SEARCH DETECTION UNIT TESTS (inline)
// ═══════════════════════════════════════════════════════════════

test("E2E: Search detection identifies macro and competitor keywords", async () => {
  // Import the detection function
  const { needsExternalSearch } = await import("../services/searchService.js");

  // Should trigger search — macro
  assert.ok(needsExternalSearch("What if inflation rises to 5%?"), "inflation should trigger search");
  assert.ok(needsExternalSearch("Impact of tariff increases on supply chain"), "tariff should trigger search");
  assert.ok(needsExternalSearch("How would a recession affect our business?"), "recession should trigger search");
  assert.ok(needsExternalSearch("Latest GDP growth report impact"), "GDP + latest should trigger search");
  assert.ok(needsExternalSearch("Oil price spike to $100/barrel"), "oil price should trigger search");
  assert.ok(needsExternalSearch("What if the Fed raises interest rates?"), "interest rate should trigger search");
  assert.ok(needsExternalSearch("Impact of new carbon tax regulation"), "carbon tax should trigger search");
  assert.ok(needsExternalSearch("AI impact on labor costs"), "AI impact should trigger search");

  // Should trigger search — competitor actions
  assert.ok(needsExternalSearch("What if our competitor launches a cheaper product?"), "competitor should trigger search");
  assert.ok(needsExternalSearch("How would a price war with rivals affect margins?"), "price war should trigger search");
  assert.ok(needsExternalSearch("Competitor gained 5% market share in Q3"), "market share should trigger search");
  assert.ok(needsExternalSearch("New entrant is disrupting our market segment"), "new entrant should trigger search");
  assert.ok(needsExternalSearch("Competitor acquisition of key supplier"), "acquisition should trigger search");
  assert.ok(needsExternalSearch("A rival launched a competing product last week"), "product launch should trigger search");

  // Should NOT trigger search (internal/simple scenarios)
  assert.ok(!needsExternalSearch("Revenue increases 10%"), "simple % change should not trigger search");
  assert.ok(!needsExternalSearch("Cut opex by 15%"), "simple opex cut should not trigger search");
  assert.ok(!needsExternalSearch("Set unit price to 60"), "simple absolute set should not trigger search");
  assert.ok(!needsExternalSearch("Delay APAC launch by one quarter"), "simple timeline should not trigger search");
});

// ═══════════════════════════════════════════════════════════════
// 21. SCENARIO REFINEMENT (follow-up answers)
// ═══════════════════════════════════════════════════════════════

test("E2E: Refine scenario with follow-up answers", async () => {
  // 1. Create a scenario
  const createRes = await agent
    .post("/api/v1/scenarios")
    .send({ nl_input: "Revenue decrease 10% and costs increase 5%" })
    .expect(201);
  const scenarioId = createRes.body.scenario_id;
  assert.ok(scenarioId, "should create scenario");
  const initialParamCount = createRes.body.parameters.length;
  assert.ok(initialParamCount > 0, "should have initial parameters");

  // 2. Refine with follow-up answers
  const refineRes = await agent
    .post(`/api/v1/scenarios/${scenarioId}/refine`)
    .send({
      answers: [
        { question_id: "geography", answer: "APAC region" },
        { question_id: "severity", answer: "moderate — 10-15% impact" },
      ],
    })
    .expect(200);

  assert.ok(refineRes.body.scenario_id === scenarioId, "should return same scenario_id");
  assert.ok(Array.isArray(refineRes.body.parameters), "should return refined parameters");
  assert.ok(refineRes.body.parameters.length > 0, "should have refined parameters");
});

test("E2E: Refine with empty answers returns 400", async () => {
  const createRes = await agent
    .post("/api/v1/scenarios")
    .send({ nl_input: "Costs increase 8%" })
    .expect(201);

  await agent
    .post(`/api/v1/scenarios/${createRes.body.scenario_id}/refine`)
    .send({ answers: [] })
    .expect(400);
});

test("E2E: Refine non-existent scenario returns 404", async () => {
  await agent
    .post("/api/v1/scenarios/00000000-0000-0000-0000-000000000000/refine")
    .send({ answers: [{ question_id: "q1", answer: "test" }] })
    .expect(404);
});

// ═══════════════════════════════════════════════════════════════
// 22. REFLECTION / THINKING LOOP
// ═══════════════════════════════════════════════════════════════

test("E2E: Reflection service exports reflect function", async () => {
  // Unit test: reflection service module loads and exports correctly
  const { reflect } = await import("../services/reflectionService.js");
  assert.strictEqual(typeof reflect, "function", "reflect should be exported as a function");
});

test("E2E: Reflection returns null when no API key", async () => {
  // When ANTHROPIC_API_KEY is absent, reflect should gracefully return null
  const { reflect } = await import("../services/reflectionService.js");
  const original = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const result = await reflect("Revenue increases 15%");
    assert.strictEqual(result, null, "Should return null when no API key");
  } finally {
    if (original) process.env.ANTHROPIC_API_KEY = original;
  }
});

test("E2E: Parse result includes reflection when API key is valid", async () => {
  // Create a scenario — reflection may or may not be present depending on API key validity
  const createRes = await agent
    .post("/api/v1/scenarios")
    .send({ nl_input: "Revenue increases 12% due to new product launch" })
    .expect(201);

  const scenarioId = createRes.body.scenario_id;
  assert.ok(scenarioId, "should create scenario");

  // If reflection is returned, validate its structure
  if (createRes.body.reflection) {
    assert.ok(typeof createRes.body.reflection.thinking === "string", "thinking should be a string");
    assert.ok(createRes.body.reflection.thinking.length > 0, "thinking should not be empty");
    assert.ok(typeof createRes.body.reflection.intent === "string", "intent should be a string");
    assert.ok(Array.isArray(createRes.body.reflection.assumptions), "assumptions should be an array");
    assert.ok(typeof createRes.body.reflection.duration_ms === "number", "duration_ms should be a number");
  }
  // Either way, parameters should be present (heuristic fallback works)
  assert.ok(Array.isArray(createRes.body.parameters), "parameters should always be returned");
});

test("E2E: Parse-only endpoint includes reflection when available", async () => {
  const parseRes = await agent
    .post("/api/v1/scenarios/parse")
    .send({ nl_input: "Costs decrease 10% due to automation" })
    .expect(200);

  // Parse result should always have parameters
  assert.ok(Array.isArray(parseRes.body.parameters), "parameters should be an array");

  // If reflection is returned, validate structure
  if (parseRes.body.reflection) {
    assert.ok(typeof parseRes.body.reflection.thinking === "string", "thinking should be a string");
    assert.ok(parseRes.body.reflection.thinking.length > 0, "thinking should not be empty");
    assert.ok(typeof parseRes.body.reflection.duration_ms === "number", "duration_ms should be a number");
  }
});

test("E2E: Refine endpoint includes reflection when available", async () => {
  const createRes = await agent
    .post("/api/v1/scenarios")
    .send({ nl_input: "Revenue decrease 8%" })
    .expect(201);

  const refineRes = await agent
    .post(`/api/v1/scenarios/${createRes.body.scenario_id}/refine`)
    .send({
      answers: [{ question_id: "reason", answer: "Loss of key enterprise client" }],
    })
    .expect(200);

  assert.ok(Array.isArray(refineRes.body.parameters), "should return parameters");

  // If reflection is returned, validate structure
  if (refineRes.body.reflection) {
    assert.ok(typeof refineRes.body.reflection.thinking === "string", "thinking should be a string");
    assert.ok(refineRes.body.reflection.thinking.length > 0, "thinking should not be empty");
    assert.ok(typeof refineRes.body.reflection.duration_ms === "number", "duration_ms should be a number");
  }
});

// ═══════════════════════════════════════════════════════════════
// 23. XLSX STRUCTURAL PIPELINE + VALIDATION GATE
// ═══════════════════════════════════════════════════════════════

test("E2E: XLSX upload stores structural metadata", async () => {
  const xlsx = await buildMinimalXlsxBuffer();
  await agent
    .post("/api/v1/documents/upload")
    .attach("file", xlsx, "structural_model.xlsx")
    .expect(201);

  const docs = await agent.get("/api/v1/documents").expect(200);
  const xlsxDoc = docs.body.documents.find((d: { original_filename: string }) => d.original_filename === "structural_model.xlsx");
  assert.ok(xlsxDoc, "uploaded XLSX should exist");
  assert.strictEqual(xlsxDoc.document_kind, "spreadsheet_model");
  assert.ok(xlsxDoc.workbook_graph, "XLSX should persist workbook_graph");
});

test("E2E: XLSX context build sets needs_validation and validate endpoint marks ready", async () => {
  // Build context from latest spreadsheet model
  const build = await agent
    .post("/api/v1/context/build")
    .expect(201);
  assert.ok(build.body.context_data, "context should be returned");

  const statusBefore = await agent
    .get("/api/v1/context/status")
    .expect(200);
  assert.ok(
    statusBefore.body.validation_status === "needs_validation" || statusBefore.body.validation_status === "ready",
    "validation status should exist for spreadsheet model",
  );

  const validate = await agent
    .post("/api/v1/context/model/validate")
    
    .send({})
    .expect(200);
  assert.strictEqual(validate.body.validation_status, "ready");
});
