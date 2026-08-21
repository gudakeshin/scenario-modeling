/**
 * Authorization & auth integration tests.
 * Requires Postgres with migrations + `npm run db:seed` (dev@local admin).
 */
import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { app } from "../index.js";
import { pool } from "../db/index.js";
import { config } from "../config.js";

const agent = request(app);
const suffix = Date.now().toString(36);
const SEED_EMAIL = "dev@example.com";
const SEED_PASSWORD = process.env.SEED_ADMIN_PASSWORD || "changeme-admin-password";

async function loginSeedAdmin() {
  const res = await agent
    .post("/api/v1/auth/login")
    .send({ email: SEED_EMAIL, password: SEED_PASSWORD });
  assert.equal(res.status, 200, `seed admin login failed: ${JSON.stringify(res.body)}`);
  return res.body as {
    access_token: string;
    refresh_token: string;
    user: { user_id: string; email: string; role: string };
  };
}

async function adminCreateUser(
  adminToken: string,
  email: string,
  password: string,
  role: string,
  name?: string
) {
  const res = await agent
    .post("/api/v1/auth/register")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ email, password, name, role });
  assert.equal(res.status, 201, `admin create user failed: ${JSON.stringify(res.body)}`);
  return res.body as { user_id: string; email: string; role: string };
}

async function login(email: string, password: string) {
  const res = await agent.post("/api/v1/auth/login").send({ email, password });
  assert.equal(res.status, 200, `login failed for ${email}: ${JSON.stringify(res.body)}`);
  return res.body as { access_token: string; refresh_token: string; user: { user_id: string; role: string } };
}

test("unauthenticated requests get 401", async () => {
  await agent.get("/api/v1/scenarios").expect(401);
  await agent.get("/api/v1/documents").expect(401);
  await agent.get("/api/v1/users/me").expect(401);
  await agent.put("/api/v1/users/me/role").send({ role: "admin" }).expect(401);
});

test("x-user-id header is inert without Bearer token", async () => {
  const res = await agent
    .get("/api/v1/scenarios")
    .set("x-user-id", "dev@local")
    .expect(401);
  assert.equal(res.body.error, "Authentication required");
});

test("self-promotion endpoint is gone", async () => {
  const admin = await loginSeedAdmin();
  const res = await agent
    .put("/api/v1/users/me/role")
    .set("Authorization", `Bearer ${admin.access_token}`)
    .send({ role: "viewer" });
  assert.ok(res.status === 404 || res.status === 405, `expected 404/405, got ${res.status}`);
});

test("viewer cannot create scenarios", async () => {
  const admin = await loginSeedAdmin();
  const viewerEmail = `viewer-${suffix}@test.local`;
  await adminCreateUser(admin.access_token, viewerEmail, "viewer-pass-123", "viewer", "Viewer");
  const viewer = await login(viewerEmail, "viewer-pass-123");
  assert.equal(viewer.user.role, "viewer");

  const res = await agent
    .post("/api/v1/scenarios")
    .set("Authorization", `Bearer ${viewer.access_token}`)
    .send({ nl_input: "Revenue up 10%" });
  assert.equal(res.status, 403);
});

test("non-owner cannot read another user's scenario", async () => {
  const admin = await loginSeedAdmin();
  const aEmail = `owner-${suffix}@test.local`;
  const bEmail = `other-${suffix}@test.local`;
  const pass = "test-password-123";

  const ownerUser = await adminCreateUser(admin.access_token, aEmail, pass, "analyst", "Owner");
  await adminCreateUser(admin.access_token, bEmail, pass, "analyst", "Other");
  const owner = await login(aEmail, pass);
  const other = await login(bEmail, pass);

  const ins = await pool.query(
    `INSERT INTO scenarios (nl_input, name, status, creator_id, model_version_hash)
     VALUES ('authz test', 'authz', 'draft', $1, 'v0') RETURNING scenario_id`,
    [ownerUser.user_id]
  );
  const scenarioId = ins.rows[0].scenario_id as string;

  // Owner can read
  await agent
    .get(`/api/v1/scenarios/${scenarioId}`)
    .set("Authorization", `Bearer ${owner.access_token}`)
    .expect(200);

  // Non-owner cannot
  await agent
    .get(`/api/v1/scenarios/${scenarioId}`)
    .set("Authorization", `Bearer ${other.access_token}`)
    .expect(403);
});

function cookieHeaderFrom(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers["set-cookie"];
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  return list.map((c) => c.split(";")[0]).join("; ");
}

test("refresh token rotation invalidates old token", async () => {
  const admin = await loginSeedAdmin();
  const email = `refresh-${suffix}@test.local`;
  await adminCreateUser(admin.access_token, email, "test-password-123", "analyst", "Refresh");

  const loginRes = await agent
    .post("/api/v1/auth/login")
    .send({ email, password: "test-password-123" })
    .expect(200);
  const initialCookie = cookieHeaderFrom(loginRes);
  assert.ok(initialCookie.includes("sm_refresh="), "login should set sm_refresh cookie");

  const first = await agent.post("/api/v1/auth/refresh").set("Cookie", initialCookie).send({}).expect(200);
  assert.ok(first.body.access_token);
  const rotatedCookie = cookieHeaderFrom(first);
  assert.ok(rotatedCookie.includes("sm_refresh="), "refresh should rotate the sm_refresh cookie");
  assert.notEqual(rotatedCookie, initialCookie, "rotated refresh cookie should differ from the original");

  // Old refresh cookie must now be rejected — rotation invalidates it.
  await agent.post("/api/v1/auth/refresh").set("Cookie", initialCookie).send({}).expect(401);

  // The newly rotated cookie still works.
  await agent.post("/api/v1/auth/refresh").set("Cookie", rotatedCookie).send({}).expect(200);
});

test("login sets auth cookies and refresh works from cookie", async () => {
  const admin = await loginSeedAdmin();
  const email = `cookie-${suffix}@test.local`;
  const password = "cookie-pass-123";
  await adminCreateUser(admin.access_token, email, password, "analyst", "Cookie User");

  const loginRes = await agent.post("/api/v1/auth/login").send({ email, password }).expect(200);
  const rawSetCookie = loginRes.headers["set-cookie"];
  const setCookie = Array.isArray(rawSetCookie)
    ? rawSetCookie
    : typeof rawSetCookie === "string"
      ? [rawSetCookie]
      : [];
  assert.ok(setCookie?.some((c) => c.startsWith("sm_refresh=")), "sm_refresh cookie should be set");
  assert.ok(setCookie?.some((c) => c.startsWith("sm_session=1")), "sm_session hint cookie should be set");

  const cookieHeader = (setCookie ?? []).map((c) => c.split(";")[0]).join("; ");
  const refreshRes = await agent
    .post("/api/v1/auth/refresh")
    .set("Cookie", cookieHeader)
    .send({})
    .expect(200);
  assert.ok(refreshRes.body.access_token, "refresh via cookie should issue access token");
});

test("audit export is scoped to approver visibility", async () => {
  const admin = await loginSeedAdmin();
  const pass = "test-password-123";

  const aEmail = `approver-a-${suffix}@test.local`;
  const bEmail = `approver-b-${suffix}@test.local`;

  const aUser = await adminCreateUser(admin.access_token, aEmail, pass, "approver", "Approver A");
  await adminCreateUser(admin.access_token, bEmail, pass, "approver", "Approver B");

  const bLogin = await login(bEmail, pass);

  const aScenario = await pool.query(
    `INSERT INTO scenarios (nl_input, name, status, creator_id, model_version_hash)
     VALUES ('audit export test A', 'audit-a', 'approved', $1, 'v0')
     RETURNING scenario_id`,
    [aUser.user_id],
  );
  const bScenario = await pool.query(
    `INSERT INTO scenarios (nl_input, name, status, creator_id, model_version_hash)
     VALUES ('audit export test B', 'audit-b', 'approved', $1, 'v0')
     RETURNING scenario_id`,
    [bLogin.user.user_id],
  );

  await pool.query(
    `INSERT INTO audit_trail (scenario_id, action_type, user_id, action_details, touched_levers_snapshot)
     VALUES ($1, 'audit_action_a', $2, '{}'::jsonb, NULL)`,
    [aScenario.rows[0].scenario_id, aUser.user_id],
  );
  await pool.query(
    `INSERT INTO audit_trail (scenario_id, action_type, user_id, action_details, touched_levers_snapshot)
     VALUES ($1, 'audit_action_b', $2, '{}'::jsonb, NULL)`,
    [bScenario.rows[0].scenario_id, bLogin.user.user_id],
  );

  const aLogin = await login(aEmail, pass);
  const res = await agent
    .get("/api/v1/audit/export?format=json")
    .set("Authorization", `Bearer ${aLogin.access_token}`)
    .expect(200);

  assert.ok(Array.isArray(res.body));
  const actionTypes = res.body.map((e: { action_type: string }) => e.action_type);
  assert.ok(actionTypes.includes("audit_action_a"), "A should see its own audit rows");
  assert.ok(!actionTypes.includes("audit_action_b"), "A must not see B's unshared audit rows");
});

test("run endpoint returns 409 when simulation already in progress", async () => {
  const admin = await loginSeedAdmin();
  const email = `runner-${suffix}@test.local`;
  const pass = "runner-pass-123";
  const runnerUser = await adminCreateUser(admin.access_token, email, pass, "analyst", "Runner");
  const runner = await login(email, pass);

  const scenario = await pool.query(
    `INSERT INTO scenarios (nl_input, name, status, creator_id, model_version_hash)
     VALUES ('run lock test', 'run-lock', 'running', $1, 'v0')
     RETURNING scenario_id`,
    [runnerUser.user_id],
  );
  const scenarioId = scenario.rows[0].scenario_id as string;

  const res = await agent
    .post(`/api/v1/scenarios/${scenarioId}/run`)
    .set("Authorization", `Bearer ${runner.access_token}`)
    .expect(409);
  assert.match(String(res.body?.error || ""), /already in progress/i);
});

test("maker-checker: creator cannot self-approve", async (t) => {
  // Maker-checker is only on by default under DEPLOYMENT_PROFILE=enterprise, so
  // pin it explicitly — this test is about the control, not about the default.
  const previous = config.ENFORCE_MAKER_CHECKER;
  config.ENFORCE_MAKER_CHECKER = true;
  t.after(() => {
    config.ENFORCE_MAKER_CHECKER = previous;
  });
  const admin = await loginSeedAdmin();
  const email = `approver-self-${suffix}@test.local`;
  const pass = "approver-pass-123";
  const creator = await adminCreateUser(admin.access_token, email, pass, "approver", "Self Approver");
  const session = await login(email, pass);

  const scenario = await pool.query(
    `INSERT INTO scenarios (nl_input, name, status, creator_id, model_version_hash)
     VALUES ('self approve test', 'self-approve', 'pending_approval', $1, 'v0')
     RETURNING scenario_id`,
    [creator.user_id],
  );
  const scenarioId = scenario.rows[0].scenario_id as string;
  await pool.query(
    `INSERT INTO scenario_parameters (scenario_id, extracted_name, mapped_variable_id, scenario_value, confidence_score, status)
     VALUES ($1, 'Revenue', 'revenue', 1.1, 0.9, 'accepted')`,
    [scenarioId],
  );

  const res = await agent
    .post(`/api/v1/scenarios/${scenarioId}/approve`)
    .set("Authorization", `Bearer ${session.access_token}`)
    .expect(403);
  assert.match(String(res.body?.error || ""), /maker-checker/i);
});

test("cleanup pool", async () => {
  await pool.end();
});
