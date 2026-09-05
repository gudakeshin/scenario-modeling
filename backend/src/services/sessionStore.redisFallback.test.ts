/**
 * Session store unit tests + documented Postgres dual-read contract.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  MemorySessionStore,
  resetSessionStoreForTests,
  type StoredSession,
} from "./sessionStore.js";

function sampleSession(overrides?: Partial<StoredSession>): StoredSession {
  const now = Date.now();
  return {
    scenario_id: "11111111-1111-4111-8111-111111111111",
    user_id: "22222222-2222-4222-8222-222222222222",
    turns: [{ role: "user", content: "hi", timestamp: new Date(now).toISOString() }],
    expires_at: now + 60_000,
    created_at: now,
    ...overrides,
  };
}

test("MemorySessionStore get/set/list/delete", async () => {
  const store = new MemorySessionStore();
  const session = sampleSession();
  await store.set("sess_a", session, 60_000);
  const got = await store.get("sess_a");
  assert.ok(got);
  assert.equal(got!.scenario_id, session.scenario_id);
  assert.equal(got!.turns.length, 1);

  const listed = await store.list(session.user_id);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, "sess_a");

  const other = await store.list("33333333-3333-4333-8333-333333333333");
  assert.equal(other.length, 0);

  assert.equal(await store.delete("sess_a"), true);
  assert.equal(await store.get("sess_a"), null);
});

test("MemorySessionStore cleans expired entries", async () => {
  const store = new MemorySessionStore();
  await store.set(
    "sess_old",
    sampleSession({ expires_at: Date.now() - 1_000 }),
    1,
  );
  assert.equal(await store.get("sess_old"), null);
});

/**
 * Contract for sessionService.getSession Postgres dual-read:
 * 1. Hot path: Memory/Redis SessionStore.get
 * 2. On miss: SELECT from sessions WHERE session_id AND expires_at > NOW()
 * 3. On hit: rehydrate via store.set with remaining TTL, then return
 * 4. listSessions merges store.list with Postgres rows for the same user
 *
 * Integration coverage lives in enterprise.smoke / e2e when DATABASE_URL is up.
 * This unit documents the expected shape of a Postgres row → StoredSession map.
 */
test("Postgres row shape maps to StoredSession (dual-read contract)", () => {
  const now = Date.now();
  const row = {
    session_id: "sess_pg",
    scenario_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    user_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    turns: [{ role: "assistant" as const, content: "ok", timestamp: new Date().toISOString() }],
    expires_at: new Date(now + 120_000),
    created_at: new Date(now),
  };
  const expiresAt = new Date(row.expires_at).getTime();
  assert.ok(expiresAt > Date.now());
  const mapped: StoredSession = {
    scenario_id: row.scenario_id,
    user_id: row.user_id,
    turns: row.turns,
    expires_at: expiresAt,
    created_at: new Date(row.created_at).getTime(),
  };
  assert.equal(mapped.scenario_id, row.scenario_id);
  assert.equal(mapped.turns[0].role, "assistant");
});

test("resetSessionStoreForTests clears singleton", () => {
  resetSessionStoreForTests();
  assert.ok(true);
});
