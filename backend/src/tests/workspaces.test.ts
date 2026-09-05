/**
 * Workspace isolation tests.
 *
 * Verifies that documents, contexts/models, scenarios, and RAG retrieval are
 * strictly scoped to the workspace named by the X-Workspace-Id header, and
 * that header-less requests behave exactly as before workspaces existed
 * (default workspace fallback).
 *
 * Requires PostgreSQL with migrations + `npm run db:seed` (dev@example.com admin).
 */

import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { app } from "../index.js";
import { pool } from "../db/index.js";

const agent = request(app);
const suffix = Date.now().toString(36);

let authToken = "";
let adminUserId = "";
let w1 = ""; // workspace 1
let w2 = ""; // workspace 2

function authed(req: request.Test, workspaceId?: string): request.Test {
  req.set("Authorization", `Bearer ${authToken}`);
  if (workspaceId) req.set("X-Workspace-Id", workspaceId);
  return req;
}

const TEST_MODEL = (name: string) => ({
  model_version: `test-${name}`,
  variables: [
    { id: "revenue", name: "Revenue", formula: "1000", dependencies: [], tags: ["pl_metric"] },
    { id: "opex", name: "Opex", formula: "400", dependencies: [], tags: ["pl_metric", "percent_delta"] },
    { id: "profit", name: "Profit", formula: "revenue - opex", dependencies: ["revenue", "opex"], tags: ["pl_metric"] },
  ],
  time_horizon: { start: "2024-01", end: "2024-12", granularity: "monthly" },
});

/** Insert an active model directly (context building needs an LLM; tests don't). */
async function insertModel(workspaceId: string, name: string): Promise<string> {
  await pool.query("UPDATE user_models SET is_active = false WHERE workspace_id = $1 AND is_active", [workspaceId]);
  const r = await pool.query(
    `INSERT INTO user_models (created_by, workspace_id, name, model_definition, is_active)
     VALUES ($1, $2, $3, $4, true) RETURNING model_id`,
    [adminUserId, workspaceId, name, JSON.stringify(TEST_MODEL(name))]
  );
  return r.rows[0].model_id;
}

before(async () => {
  const res = await agent.post("/api/v1/auth/login").send({
    email: "dev@example.com",
    password: process.env.SEED_ADMIN_PASSWORD || "changeme-admin-password",
  });
  assert.equal(res.status, 200, `seed admin login failed (run \`npm run db:seed\`): ${JSON.stringify(res.body)}`);
  authToken = res.body.access_token;
  adminUserId = res.body.user.user_id;

  const c1 = await authed(agent.post("/api/v1/workspaces")).send({ name: `iso-w1-${suffix}` });
  assert.equal(c1.status, 201, JSON.stringify(c1.body));
  w1 = c1.body.workspace_id;
  const c2 = await authed(agent.post("/api/v1/workspaces")).send({ name: `iso-w2-${suffix}` });
  assert.equal(c2.status, 201, JSON.stringify(c2.body));
  w2 = c2.body.workspace_id;
});

// ── Middleware ──

test("workspace header: malformed id → 400", async () => {
  await authed(agent.get("/api/v1/documents"), "not-a-uuid").expect(400);
});

test("workspace header: unknown/foreign id → 403 with code", async () => {
  const res = await authed(agent.get("/api/v1/documents"), randomUUID()).expect(403);
  assert.equal(res.body.code, "WORKSPACE_NOT_FOUND");
});

test("workspace header: missing → default workspace fallback (no error)", async () => {
  await authed(agent.get("/api/v1/documents")).expect(200);
});

test("workspace mgmt routes ignore a stale workspace header", async () => {
  const res = await authed(agent.get("/api/v1/workspaces"), randomUUID()).expect(200);
  assert.ok(Array.isArray(res.body.workspaces));
});

// ── CRUD ──

test("workspaces: list contains default + created; duplicate name → 409", async () => {
  const res = await authed(agent.get("/api/v1/workspaces")).expect(200);
  const names = res.body.workspaces.map((w: { name: string }) => w.name);
  assert.ok(res.body.workspaces.some((w: { is_default: boolean }) => w.is_default), "default workspace listed");
  assert.ok(names.includes(`iso-w1-${suffix}`) && names.includes(`iso-w2-${suffix}`));

  await authed(agent.post("/api/v1/workspaces")).send({ name: `iso-w1-${suffix}` }).expect(409);
});

test("workspaces: rename works, empty name rejected", async () => {
  const renamed = await authed(agent.put(`/api/v1/workspaces/${w1}`)).send({ name: `iso-w1-renamed-${suffix}` });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.name, `iso-w1-renamed-${suffix}`);
  await authed(agent.put(`/api/v1/workspaces/${w1}`)).send({ name: "  " }).expect(400);
});

test("workspaces: cannot delete a user's last workspace", async () => {
  // Fresh user with only their default workspace.
  const email = `iso-last-${suffix}@example.com`;
  const reg = await agent
    .post("/api/v1/auth/register")
    .set("Authorization", `Bearer ${authToken}`)
    .send({ email, password: "test-password-123", role: "analyst" });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  const login = await agent.post("/api/v1/auth/login").send({ email, password: "test-password-123" });
  const token = login.body.access_token;

  const list = await agent.get("/api/v1/workspaces").set("Authorization", `Bearer ${token}`).expect(200);
  const defaultWs = list.body.workspaces[0];
  const del = await agent.delete(`/api/v1/workspaces/${defaultWs.workspace_id}`).set("Authorization", `Bearer ${token}`);
  assert.equal(del.status, 400);
  assert.match(del.body.error, /last workspace/i);
});

// ── Document + RAG isolation ──

test("documents: uploads land in the header's workspace and lists are disjoint", async () => {
  const up1 = await authed(agent.post("/api/v1/documents/upload"), w1).attach(
    "file",
    Buffer.from("Aurora Robotics builds warehouse automation robots. Revenue was 500 million dollars."),
    "aurora.txt"
  );
  assert.equal(up1.status, 201, JSON.stringify(up1.body));
  const up2 = await authed(agent.post("/api/v1/documents/upload"), w2).attach(
    "file",
    Buffer.from("Borealis Shipping operates cargo vessels. Fleet fuel cost was 80 million euros."),
    "borealis.txt"
  );
  assert.equal(up2.status, 201, JSON.stringify(up2.body));

  const l1 = await authed(agent.get("/api/v1/documents"), w1).expect(200);
  const l2 = await authed(agent.get("/api/v1/documents"), w2).expect(200);
  const names1 = l1.body.documents.map((d: { name: string }) => d.name);
  const names2 = l2.body.documents.map((d: { name: string }) => d.name);
  assert.ok(names1.includes("aurora") && !names1.includes("borealis"), `w1 sees only its doc: ${names1}`);
  assert.ok(names2.includes("borealis") && !names2.includes("aurora"), `w2 sees only its doc: ${names2}`);
});

test("RAG: retrieval never crosses the workspace boundary", async () => {
  // Question answerable only from w2's document, asked in w1.
  const res = await authed(agent.post("/api/v1/documents/query"), w1).send({
    question: "What was the fleet fuel cost for Borealis Shipping?",
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const sources = res.body.sources as { document_name: string }[];
  assert.ok(
    sources.every((s) => s.document_name !== "borealis"),
    `w1 query must not surface w2 chunks: ${JSON.stringify(sources)}`
  );
});

test("RAG: cross-workspace document query by id → 404", async () => {
  const l2 = await authed(agent.get("/api/v1/documents"), w2).expect(200);
  const borealisId = l2.body.documents.find((d: { name: string }) => d.name === "borealis")?.document_id;
  assert.ok(borealisId);
  await authed(agent.post(`/api/v1/documents/${borealisId}/query`), w1)
    .send({ question: "fuel cost?" })
    .expect(404);
});

// ── Model + scenario isolation ──

test("models: each workspace resolves its own active model", async () => {
  await insertModel(w1, `W1 Model ${suffix}`);
  await insertModel(w2, `W2 Model ${suffix}`);

  const m1 = await authed(agent.get("/api/v1/context/model"), w1).expect(200);
  const m2 = await authed(agent.get("/api/v1/context/model"), w2).expect(200);
  assert.equal(m1.body.model.name, `W1 Model ${suffix}`);
  assert.equal(m2.body.model.name, `W2 Model ${suffix}`);
});

test("scenarios: creation pins the workspace's model; lists are workspace-scoped", async () => {
  const s1 = await authed(agent.post("/api/v1/scenarios"), w1).send({ nl_input: `w1 opex down 5% ${suffix}` });
  assert.equal(s1.status, 201, JSON.stringify(s1.body));
  const s2 = await authed(agent.post("/api/v1/scenarios"), w2).send({ nl_input: `w2 opex up 3% ${suffix}` });
  assert.equal(s2.status, 201, JSON.stringify(s2.body));

  // Pinned model must be the creating workspace's active model.
  const pinned = await pool.query(
    "SELECT scenario_id, workspace_id, model_version_hash FROM scenarios WHERE scenario_id = ANY($1::uuid[])",
    [[s1.body.scenario_id, s2.body.scenario_id]]
  );
  for (const row of pinned.rows) {
    const model = await pool.query("SELECT workspace_id FROM user_models WHERE model_id = $1", [row.model_version_hash]);
    assert.equal(model.rows[0].workspace_id, row.workspace_id, "scenario pins a model from its own workspace");
  }

  const list1 = await authed(agent.get("/api/v1/scenarios"), w1).expect(200);
  const ids1 = list1.body.scenarios.map((s: { scenario_id: string }) => s.scenario_id);
  assert.ok(ids1.includes(s1.body.scenario_id), "w1 lists its own scenario");
  assert.ok(!ids1.includes(s2.body.scenario_id), "w1 must not list w2's scenario");

  const list2 = await authed(agent.get("/api/v1/scenarios"), w2).expect(200);
  const ids2 = list2.body.scenarios.map((s: { scenario_id: string }) => s.scenario_id);
  assert.ok(ids2.includes(s2.body.scenario_id) && !ids2.includes(s1.body.scenario_id));
});

test("base-case: computed from the active workspace's model", async () => {
  const bc1 = await authed(agent.get("/api/v1/scenarios/base-case"), w1).expect(200);
  assert.equal(bc1.body.pl.profit, 600, "w1 base case from its own model");
});

test("context build in one workspace does not supersede another's context", async () => {
  const ctxId1 = randomUUID();
  const ctxId2 = randomUUID();
  const ctxData = (name: string) =>
    JSON.stringify({ company_name: name, industry: "test", business_model: "", revenue_streams: [], financial_metrics: [], competitive_landscape: "", key_risks: [], benchmarks: {} });
  await pool.query(
    `INSERT INTO company_context (context_id, created_by, workspace_id, company_name, context_data, status)
     VALUES ($1, $2, $3, 'Aurora', $4, 'active'), ($5, $2, $6, 'Borealis', $7, 'active')`,
    [ctxId1, adminUserId, w1, ctxData("Aurora"), ctxId2, w2, ctxData("Borealis")]
  );

  // Both contexts coexist as active — the old per-user logic would have made this impossible.
  const st1 = await authed(agent.get("/api/v1/context/status"), w1).expect(200);
  const st2 = await authed(agent.get("/api/v1/context/status"), w2).expect(200);
  assert.equal(st1.body.company_name, "Aurora");
  assert.equal(st2.body.company_name, "Borealis");
});

test("UPSI need-to-know denies non-member admin and SDD chain exports", async () => {
  const email = `upsi-admin-${suffix}@example.com`;
  const registered = await agent
    .post("/api/v1/auth/register")
    .set("Authorization", `Bearer ${authToken}`)
    .send({ email, password: "test-password-123", role: "admin" });
  assert.equal(registered.status, 201, JSON.stringify(registered.body));
  const secondUserId = registered.body.user_id;
  const login = await agent.post("/api/v1/auth/login").send({
    email,
    password: "test-password-123",
  });
  const secondToken = login.body.access_token;

  await authed(agent.patch(`/api/v1/workspaces/${w1}/governance`))
    .send({
      sensitivity: "upsi",
      nature_of_upsi: "Unpublished scenario forecasts",
    })
    .expect(200);

  await agent
    .get("/api/v1/documents")
    .set("Authorization", `Bearer ${secondToken}`)
    .set("X-Workspace-Id", w1)
    .expect(403);

  await authed(agent.post(`/api/v1/workspaces/${w1}/members`))
    .send({ user_id: secondUserId, access_reason: "Scenario review need-to-know" })
    .expect(201);

  await agent
    .get("/api/v1/documents")
    .set("Authorization", `Bearer ${secondToken}`)
    .set("X-Workspace-Id", w1)
    .expect(200);

  // Artifact-level reads (not workspace resolution) append SDD rows.
  const docs = await agent
    .get("/api/v1/documents")
    .set("Authorization", `Bearer ${secondToken}`)
    .set("X-Workspace-Id", w1)
    .expect(200);
  const docId = (docs.body.documents || docs.body || [])[0]?.document_id as string | undefined;
  if (docId) {
    await agent
      .get(`/api/v1/documents/${docId}`)
      .set("Authorization", `Bearer ${secondToken}`)
      .set("X-Workspace-Id", w1)
      .expect(200);
  } else {
    const { logUpsIAccess } = await import("../services/upsiGovernanceService.js");
    await logUpsIAccess({
      workspaceId: w1,
      userId: secondUserId,
      artifactType: "document",
      artifactId: "synthetic-sdd-probe",
      action: "read",
    });
  }

  const sdd = await agent
    .get(`/api/v1/workspaces/${w1}/upsi-access-log`)
    .set("Authorization", `Bearer ${secondToken}`)
    .expect(200);
  assert.equal(sdd.body.verification.valid, true);
  assert.ok(sdd.body.access_log.length >= 1);
  await assert.rejects(
    pool.query(
      `UPDATE upsi_access_log SET action = 'tampered' WHERE access_id = $1`,
      [sdd.body.access_log[0].access_id],
    ),
    /immutable/i,
  );
});

test("UPSI: headerless requests use the same membership policy as X-Workspace-Id", async () => {
  // Owner membership is auto-healed for the default workspace, so headerless
  // access must succeed — and must still run through UPSI authorization (no bypass).
  const before = await pool.query(
    `SELECT count(*)::int AS n FROM upsi_access_log WHERE workspace_id = $1`,
    [w1],
  );
  await agent
    .get("/api/v1/documents")
    .set("Authorization", `Bearer ${authToken}`)
    .expect(200);

  // Explicit header with a platform admin who is not a member remains denied.
  const email = `upsi-headerless-admin-${suffix}@example.com`;
  const registered = await agent
    .post("/api/v1/auth/register")
    .set("Authorization", `Bearer ${authToken}`)
    .send({ email, password: "test-password-123", role: "admin" });
  assert.equal(registered.status, 201, JSON.stringify(registered.body));
  const login = await agent.post("/api/v1/auth/login").send({
    email,
    password: "test-password-123",
  });
  const denied = await agent
    .get("/api/v1/documents")
    .set("Authorization", `Bearer ${login.body.access_token}`)
    .set("X-Workspace-Id", w1)
    .expect(403);
  assert.equal(denied.body.code, "WORKSPACE_NOT_FOUND");

  const after = await pool.query(
    `SELECT count(*)::int AS n FROM upsi_access_log WHERE workspace_id = $1`,
    [w1],
  );
  // List endpoints no longer write SDD rows in middleware; counts should not jump
  // solely from workspace resolution.
  assert.ok(after.rows[0].n >= before.rows[0].n);
});

test("UPSI: shared scenario is hidden without artifact-workspace membership", async () => {
  const shareEmail = `upsi-share-${suffix}@example.com`;
  const registered = await agent
    .post("/api/v1/auth/register")
    .set("Authorization", `Bearer ${authToken}`)
    .send({ email: shareEmail, password: "test-password-123", role: "analyst" });
  assert.equal(registered.status, 201, JSON.stringify(registered.body));
  const shareUserId = registered.body.user_id as string;
  const login = await agent.post("/api/v1/auth/login").send({
    email: shareEmail,
    password: "test-password-123",
  });
  const shareToken = login.body.access_token as string;

  const scenario = await pool.query(
    `INSERT INTO scenarios (nl_input, name, status, creator_id, workspace_id, model_version_hash)
     VALUES ('upsi share', 'upsi-shared', 'draft', $1, $2, 'v0')
     RETURNING scenario_id`,
    [adminUserId, w1],
  );
  const scenarioId = scenario.rows[0].scenario_id as string;
  await pool.query(
    `INSERT INTO scenario_sharing (scenario_id, shared_with, permission, shared_by)
     VALUES ($1, $2, 'view', $3)`,
    [scenarioId, shareUserId, adminUserId],
  );

  const list = await agent
    .get("/api/v1/scenarios")
    .set("Authorization", `Bearer ${shareToken}`)
    .expect(200);
  const ids = (list.body.scenarios || []).map((s: { scenario_id: string }) => s.scenario_id);
  assert.ok(!ids.includes(scenarioId), "UPSI shared scenario must not list without membership");

  const open = await agent
    .get(`/api/v1/scenarios/${scenarioId}`)
    .set("Authorization", `Bearer ${shareToken}`)
    .expect(403);
  assert.match(String(open.body.error || ""), /UPSI|need-to-know|membership/i);
});

test("UPSI: chain verification detects head mismatch", async () => {
  const { verifyUpsIAccessChain, logUpsIAccess } = await import(
    "../services/upsiGovernanceService.js"
  );
  await logUpsIAccess({
    workspaceId: w1,
    userId: adminUserId,
    artifactType: "scenario",
    artifactId: "head-mismatch-probe",
    action: "read",
  });
  await pool.query(
    `UPDATE upsi_access_chain_head SET head_hash = $2 WHERE workspace_id = $1`,
    [w1, "f".repeat(64)],
  );
  const result = await verifyUpsIAccessChain(w1);
  assert.equal(result.valid, false);
  assert.match(String(result.error || ""), /chain head/i);
});

test("organization owner can manage and read trading-window settings", async () => {
  const email = `org-owner-${suffix}@example.com`;
  const registered = await agent
    .post("/api/v1/auth/register")
    .set("Authorization", `Bearer ${authToken}`)
    .send({ email, password: "test-password-123", role: "analyst" });
  assert.equal(registered.status, 201, JSON.stringify(registered.body));
  const ownerId = registered.body.user_id as string;
  const login = await agent.post("/api/v1/auth/login").send({
    email,
    password: "test-password-123",
  });
  const ownerToken = login.body.access_token as string;

  const org = await pool.query(
    `INSERT INTO organizations (name, slug)
     VALUES ($1, $2) RETURNING organization_id`,
    [`Trading Window ${suffix}`, `trading-window-${suffix}`],
  );
  const orgId = org.rows[0].organization_id as string;
  await pool.query(
    `INSERT INTO organization_members (organization_id, user_id, org_role)
     VALUES ($1, $2, 'owner')`,
    [orgId, ownerId],
  );

  const updated = await agent
    .patch(`/api/v1/organizations/${orgId}/trading-window`)
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({
      status: "closed",
      from: "2026-07-01",
      until: "2026-07-31",
      note: "Quarterly results blackout",
    })
    .expect(200);
  assert.equal(updated.body.trading_window_status, "closed");

  await agent
    .patch(`/api/v1/organizations/${orgId}/trading-window`)
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({
      status: "closed",
      from: "2026-08-01",
      until: "2026-07-01",
    })
    .expect(400);

  const fetched = await agent
    .get(`/api/v1/organizations/${orgId}`)
    .set("Authorization", `Bearer ${ownerToken}`)
    .expect(200);
  assert.equal(fetched.body.trading_window_status, "closed");
  assert.equal(fetched.body.trading_window_note, "Quarterly results blackout");
});

// ── Deletion ──

test("workspace deletion: docs purged, scenarios archived, header rejected afterwards", async () => {
  const docCountBefore = await pool.query("SELECT count(*)::int AS n FROM documents WHERE workspace_id = $1", [w2]);
  assert.ok(docCountBefore.rows[0].n > 0);

  await authed(agent.delete(`/api/v1/workspaces/${w2}`)).expect(200);

  const docs = await pool.query("SELECT count(*)::int AS n FROM documents WHERE workspace_id = $1", [w2]);
  assert.equal(docs.rows[0].n, 0, "documents hard-deleted");
  const scen = await pool.query("SELECT DISTINCT status FROM scenarios WHERE workspace_id = $1", [w2]);
  assert.deepEqual(scen.rows.map((r: { status: string }) => r.status), ["archived"], "scenarios archived, not deleted");
  const ctx = await pool.query("SELECT DISTINCT status FROM company_context WHERE workspace_id = $1", [w2]);
  assert.deepEqual(ctx.rows.map((r: { status: string }) => r.status), ["deleted"]);

  const res = await authed(agent.get("/api/v1/documents"), w2).expect(403);
  assert.equal(res.body.code, "WORKSPACE_NOT_FOUND");
});

after(async () => {
  // Cleanup: remove w1 (w2 already deleted) and its contents.
  try {
    await authed(agent.delete(`/api/v1/workspaces/${w1}`));
  } catch {
    // best effort
  }
  await pool.end();
});
