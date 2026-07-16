/**
 * Chat conversation persistence API tests — CRUD, message append, and
 * workspace isolation (a user must not be able to read/list another
 * workspace's conversations even when both workspaces belong to them).
 *
 * Requires: migrations applied, npm run db:seed.
 */

import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";

const { app } = await import("../index.js");

const agent = request(app);
const suffix = Date.now().toString(36);

let authToken = "";
let w1 = ""; // workspace 1
let w2 = ""; // workspace 2
let convIdInW1 = "";

function authed(req: request.Test, workspaceId?: string): request.Test {
  req.set("Authorization", `Bearer ${authToken}`);
  if (workspaceId) req.set("X-Workspace-Id", workspaceId);
  return req;
}

before(async () => {
  const login = await agent.post("/api/v1/auth/login").send({
    email: "dev@example.com",
    password: process.env.SEED_ADMIN_PASSWORD || "changeme-admin-password",
  });
  if (login.status !== 200) {
    console.warn("Skipping conversations tests — seed admin login failed");
    return;
  }
  authToken = login.body.access_token;

  const c1 = await authed(agent.post("/api/v1/workspaces")).send({ name: `conv-w1-${suffix}` });
  assert.equal(c1.status, 201, JSON.stringify(c1.body));
  w1 = c1.body.workspace_id;
  const c2 = await authed(agent.post("/api/v1/workspaces")).send({ name: `conv-w2-${suffix}` });
  assert.equal(c2.status, 201, JSON.stringify(c2.body));
  w2 = c2.body.workspace_id;
});

after(async () => {
  // pool kept open by other tests; no close
});

test("create conversation in workspace 1", async () => {
  if (!authToken) return;
  const res = await authed(agent.post("/api/v1/conversations"), w1).send({ title: "Test scenario chat" });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  convIdInW1 = res.body.id;
  assert.ok(convIdInW1);
  assert.equal(res.body.workspace_id, w1);
});

test("append messages and read back in order", async () => {
  if (!convIdInW1) return;
  const m1 = await authed(agent.post(`/api/v1/conversations/${convIdInW1}/messages`), w1).send({
    role: "user",
    content: "What if revenue grows 10%?",
  });
  assert.equal(m1.status, 201, JSON.stringify(m1.body));

  const m2 = await authed(agent.post(`/api/v1/conversations/${convIdInW1}/messages`), w1).send({
    role: "assistant",
    content: "Modeling a 10% revenue increase.",
    metadata: { agentConfidence: 0.8 },
  });
  assert.equal(m2.status, 201, JSON.stringify(m2.body));

  const got = await authed(agent.get(`/api/v1/conversations/${convIdInW1}`), w1);
  assert.equal(got.status, 200);
  assert.equal(got.body.messages.length, 2);
  assert.equal(got.body.messages[0].role, "user");
  assert.equal(got.body.messages[1].role, "assistant");
  assert.equal(got.body.messages[1].metadata.agentConfidence, 0.8);
});

test("list scoped to workspace: appears in w1, absent from w2", async () => {
  if (!convIdInW1) return;
  const listW1 = await authed(agent.get("/api/v1/conversations"), w1);
  assert.equal(listW1.status, 200);
  assert.ok(listW1.body.conversations.some((c: { id: string }) => c.id === convIdInW1));

  const listW2 = await authed(agent.get("/api/v1/conversations"), w2);
  assert.equal(listW2.status, 200);
  assert.ok(!listW2.body.conversations.some((c: { id: string }) => c.id === convIdInW1));
});

test("get by id from wrong workspace → 404 (no cross-workspace read)", async () => {
  if (!convIdInW1) return;
  const res = await authed(agent.get(`/api/v1/conversations/${convIdInW1}`), w2);
  assert.equal(res.status, 404);
});

test("append message from wrong workspace → 404 (no cross-workspace write)", async () => {
  if (!convIdInW1) return;
  const res = await authed(agent.post(`/api/v1/conversations/${convIdInW1}/messages`), w2).send({
    role: "user",
    content: "should not be allowed",
  });
  assert.equal(res.status, 404);
});

test("rename from wrong workspace → 404", async () => {
  if (!convIdInW1) return;
  const res = await authed(agent.put(`/api/v1/conversations/${convIdInW1}`), w2).send({
    title: "hijacked",
  });
  assert.equal(res.status, 404);
});

test("delete from wrong workspace → 404, then succeeds from correct workspace", async () => {
  if (!convIdInW1) return;
  const wrong = await authed(agent.delete(`/api/v1/conversations/${convIdInW1}`), w2);
  assert.equal(wrong.status, 404);

  const right = await authed(agent.delete(`/api/v1/conversations/${convIdInW1}`), w1);
  assert.equal(right.status, 204);
});

test("no auth token → 401", async () => {
  const res = await agent.get("/api/v1/conversations");
  assert.equal(res.status, 401);
});
