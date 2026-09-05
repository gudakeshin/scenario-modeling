/**
 * SAC write-back unit tests — skip when Postgres is unavailable.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { pool } from "../db/index.js";
import { writeBackToSac } from "./sacWriteback.js";

let dbOk = false;
try {
  await pool.query("SELECT 1");
  dbOk = true;
} catch {
  dbOk = false;
}

test("writeBackToSac rejects short idempotency key", { skip: !dbOk }, async () => {
  await assert.rejects(
    () =>
      writeBackToSac({
        connection_id: "00000000-0000-4000-8000-000000000001",
        workspace_id: "00000000-0000-4000-8000-000000000002",
        scenario_id: "00000000-0000-4000-8000-000000000003",
        user_id: "00000000-0000-4000-8000-000000000004",
        measure_values: [{ measure_id: "m", member_key: "k", value: 1 }],
        idempotency_key: "short",
      }),
    (e: Error & { status?: number }) =>
      /idempotency_key/i.test(e.message) && e.status === 400,
  );
});

test("writeBackToSac rejects missing scenario", { skip: !dbOk }, async () => {
  await assert.rejects(
    () =>
      writeBackToSac({
        connection_id: "00000000-0000-4000-8000-000000000001",
        workspace_id: "00000000-0000-4000-8000-000000000002",
        scenario_id: "00000000-0000-4000-8000-000000000099",
        user_id: "00000000-0000-4000-8000-000000000004",
        measure_values: [{ measure_id: "m", member_key: "k", value: 1 }],
        idempotency_key: "idem-key-missing-scenario",
      }),
    (e: Error & { status?: number }) =>
      /not found/i.test(e.message) && e.status === 404,
  );
});
