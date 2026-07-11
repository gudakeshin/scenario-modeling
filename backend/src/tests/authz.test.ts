/**
 * Authorization & auth integration tests.
 * Requires Postgres with migrations + `npm run db:seed` (dev@local admin).
 */
import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { app } from "../index.js";
import { pool } from "../db/index.js";

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

test("refresh token rotation invalidates old token", async () => {
  const admin = await loginSeedAdmin();
  const email = `refresh-${suffix}@test.local`;
  await adminCreateUser(admin.access_token, email, "test-password-123", "analyst", "Refresh");
  const auth = await login(email, "test-password-123");
  assert.ok(auth.refresh_token);

  const first = await agent
    .post("/api/v1/auth/refresh")
    .send({ refresh_token: auth.refresh_token })
    .expect(200);
  assert.ok(first.body.access_token);
  assert.ok(first.body.refresh_token);
  assert.notEqual(first.body.refresh_token, auth.refresh_token);

  await agent
    .post("/api/v1/auth/refresh")
    .send({ refresh_token: auth.refresh_token })
    .expect(401);

  await agent
    .post("/api/v1/auth/refresh")
    .send({ refresh_token: first.body.refresh_token })
    .expect(200);
});

test("cleanup pool", async () => {
  await pool.end();
});
