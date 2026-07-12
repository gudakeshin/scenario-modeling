/**
 * Hybrid retrieval contract: keyword path always works; vector path is optional.
 */

import test from "node:test";
import assert from "node:assert";
import { searchDocumentChunksInDb } from "./documentService.js";

test("hybrid retrieval: empty query returns empty without throwing", async () => {
  const results = await searchDocumentChunksInDb("", "00000000-0000-0000-0000-000000000002", 5);
  assert.ok(Array.isArray(results));
  assert.strictEqual(results.length, 0);
});

test("hybrid retrieval: workspace-scoped search returns array (keyword fallback OK)", async () => {
  // Uses a random workspace — may be empty in unit env; must not throw.
  const results = await searchDocumentChunksInDb(
    "revenue margin",
    "00000000-0000-0000-0000-000000000099",
    3,
  );
  assert.ok(Array.isArray(results));
  for (const r of results) {
    assert.ok(typeof r.text === "string");
    assert.ok(typeof r.score === "number");
  }
});
