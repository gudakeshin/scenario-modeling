import test, { before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import request from "supertest";

process.env.NODE_ENV = "test";
process.env.ENABLE_PLANNING_CONNECTORS = "1";
process.env.CREDENTIALS_ENCRYPTION_KEY =
  process.env.CREDENTIALS_ENCRYPTION_KEY || randomBytes(32).toString("hex");
delete process.env.ANTHROPIC_API_KEY;

const { app } = await import("../index.js");
const { pool } = await import("../db/index.js");

const agent = request(app);
const suffix = Date.now().toString(36);
let token = "";
let userId = "";
let makerUserId = "";
let workspaceId = "";
let connectionId = "";
let snapshotId = "";
let modelId = "";

function authed(req: request.Test): request.Test {
  req.set("Authorization", `Bearer ${token}`);
  if (workspaceId) req.set("X-Workspace-Id", workspaceId);
  return req;
}

before(async () => {
  const login = await agent.post("/api/v1/auth/login").send({
    email: "dev@example.com",
    password: process.env.SEED_ADMIN_PASSWORD || "changeme-admin-password",
  });
  if (login.status !== 200) return;
  token = login.body.access_token;
  const user = await pool.query("SELECT user_id FROM users WHERE email = $1", ["dev@example.com"]);
  userId = user.rows[0].user_id;
  const maker = await pool.query(
    `INSERT INTO users (email, name, role)
     VALUES ($1, 'Dimensional Pipeline Maker', 'analyst')
     RETURNING user_id`,
    [`dimensional-maker-${suffix}@test.local`],
  );
  makerUserId = maker.rows[0].user_id;
  const workspace = await authed(agent.post("/api/v1/workspaces")).send({
    name: `dimensional-pipeline-${suffix}`,
  });
  workspaceId = workspace.body.workspace_id;
});

test("mock import activates dimensional model and scoped scenario runs", async () => {
  if (!token || !workspaceId) return;

  const connection = await authed(agent.post("/api/v1/connections")).send({
    provider: "mock",
    name: `mock-dimensional-${suffix}`,
    base_url: "mock://local",
    auth_kind: "api_key",
    auth_public: {},
    secret: "pipeline-test-secret",
  });
  assert.equal(connection.status, 201, JSON.stringify(connection.body));
  connectionId = connection.body.connection_id;

  const models = await authed(agent.get(`/api/v1/connections/${connectionId}/models`));
  assert.equal(models.status, 200, JSON.stringify(models.body));
  const externalModelId = models.body.models[0].id;
  const started = await authed(
    agent.post(
      `/api/v1/connections/${connectionId}/models/${encodeURIComponent(externalModelId)}/import`,
    ),
  ).send({ fact_query: { versionMemberId: "actual" } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  snapshotId = started.body.snapshot_id;

  let snapshotStatus = "importing";
  for (let attempt = 0; attempt < 60; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const snapshot = await authed(agent.get(`/api/v1/connections/imports/${snapshotId}`));
    assert.equal(snapshot.status, 200, JSON.stringify(snapshot.body));
    snapshotStatus = snapshot.body.status;
    if (snapshotStatus === "ready" || snapshotStatus === "failed") break;
  }
  assert.equal(snapshotStatus, "ready");

  const active = await pool.query(
    `SELECT model_id, source_kind, snapshot_id
     FROM user_models WHERE workspace_id = $1 AND is_active = true`,
    [workspaceId],
  );
  assert.equal(active.rows.length, 1);
  assert.equal(active.rows[0].source_kind, "external_model");
  assert.equal(active.rows[0].snapshot_id, snapshotId);
  modelId = active.rows[0].model_id;

  const scenario = await pool.query(
    `INSERT INTO scenarios
       (name, nl_input, status, creator_id, workspace_id, model_version_hash)
     VALUES ($1, $2, 'draft', $3, $4, $5)
     RETURNING scenario_id`,
    [
      `EMEA revenue uplift ${suffix}`,
      "Increase EMEA revenue by 10%",
      makerUserId,
      workspaceId,
      modelId,
    ],
  );
  const scenarioId = scenario.rows[0].scenario_id;
  await pool.query(
    `INSERT INTO scenario_parameters
       (scenario_id, extracted_name, mapped_variable_id, scenario_value, delta_type,
        confidence_score, status, member_scope)
     VALUES ($1, 'EMEA revenue', 'amount', 10, 'percent', 1, 'accepted', $2)`,
    [scenarioId, JSON.stringify({ region: "emea", account: "revenue" })],
  );

  const approved = await authed(agent.post(`/api/v1/scenarios/${scenarioId}/approve`));
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  const run = await authed(agent.post(`/api/v1/scenarios/${scenarioId}/run`));
  assert.equal(run.status, 200, JSON.stringify(run.body));
  assert.equal(run.body.simulation_mode, "external_model");
  assert.ok(run.body.dimensional?.breakdowns?.amount?.region);
  assert.equal(run.body.dimensional?.member_catalog?.region?.emea, "EMEA");

  const parameters = await authed(agent.get(`/api/v1/scenarios/${scenarioId}/parameters`));
  assert.equal(parameters.status, 200);
  assert.equal(parameters.body.parameters[0].delta_type, "percent");
  assert.deepEqual(parameters.body.parameters[0].member_scope, {
    region: "emea",
    account: "revenue",
  });

  const slice = await authed(agent.post(`/api/v1/scenarios/${scenarioId}/pov-slice`)).send({
    pov: { region: "emea" },
    metrics: ["amount"],
  });
  assert.equal(slice.status, 200, JSON.stringify(slice.body));
  assert.equal(typeof slice.body.pl.amount, "number");
  assert.ok(slice.body.dimensional?.breakdowns?.amount);
});
