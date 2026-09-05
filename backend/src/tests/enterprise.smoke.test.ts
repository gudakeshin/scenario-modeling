/**
 * Enterprise foundation smoke tests.
 * Skips DB-dependent cases when Postgres is unreachable (same pattern as authz/e2e).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { MemorySessionStore, resetSessionStoreForTests } from "../services/sessionStore.js";
import {
  isObjectStorageEnabled,
  loadDocumentBytes,
  backfillDocumentsToObjectStorage,
} from "../services/objectStorage.js";
import { pool } from "../db/index.js";

let dbOk = false;
let orgsTableOk = false;
try {
  await pool.query("SELECT 1");
  dbOk = true;
  const t = await pool.query(`SELECT to_regclass('public.organizations') AS reg`);
  orgsTableOk = Boolean(t.rows[0]?.reg);
} catch {
  dbOk = false;
}

test("MemorySessionStore smoke", async () => {
  resetSessionStoreForTests();
  const store = new MemorySessionStore();
  const now = Date.now();
  await store.set(
    "sess_smoke",
    {
      scenario_id: "11111111-1111-4111-8111-111111111111",
      user_id: "22222222-2222-4222-8222-222222222222",
      turns: [],
      expires_at: now + 60_000,
      created_at: now,
    },
    60_000,
  );
  const got = await store.get("sess_smoke");
  assert.ok(got);
  assert.equal(got!.user_id, "22222222-2222-4222-8222-222222222222");
  await store.delete("sess_smoke");
});

test("object storage memory/BYTEA fallback when unset", async () => {
  // Without OBJECT_STORAGE_* credentials, dual-read falls back to BYTEA
  assert.equal(isObjectStorageEnabled(), Boolean(
    process.env.OBJECT_STORAGE_BUCKET &&
      process.env.OBJECT_STORAGE_ACCESS_KEY &&
      process.env.OBJECT_STORAGE_SECRET_KEY,
  ));
  const bytes = await loadDocumentBytes({
    document_id: "doc",
    storage_key: null,
    file_bytes: Buffer.from("hello-bytes"),
  });
  assert.ok(bytes);
  assert.equal(bytes!.toString("utf8"), "hello-bytes");

  if (!isObjectStorageEnabled()) {
    const result = await backfillDocumentsToObjectStorage({ limit: 1 });
    assert.deepEqual(result, { migrated: 0, skipped: 0, errors: 0 });
  }
});

test("org create and list (DB)", { skip: !dbOk || !orgsTableOk }, async () => {
  const { createOrganization, listOrganizationsForUser, deleteOrganization } =
    await import("../services/organizationService.js");

  // Prefer seed admin; otherwise create ephemeral user
  let userId: string;
  const seed = await pool.query(
    `SELECT user_id FROM users WHERE email = 'dev@example.com' LIMIT 1`,
  );
  if (seed.rows[0]) {
    userId = seed.rows[0].user_id;
  } else {
    const u = await pool.query(
      `INSERT INTO users (email, name, role)
       VALUES ($1, 'Org Smoke', 'admin')
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
       RETURNING user_id`,
      [`org-smoke-${Date.now()}@test.local`],
    );
    userId = u.rows[0].user_id;
  }

  const slug = `smoke-org-${Date.now().toString(36)}`;
  const org = await createOrganization(`Smoke Org ${slug}`, userId, slug);
  assert.ok(org.organization_id);

  const listed = await listOrganizationsForUser(userId);
  assert.ok(listed.some((o) => o.organization_id === org.organization_id));

  await deleteOrganization(org.organization_id);
});
