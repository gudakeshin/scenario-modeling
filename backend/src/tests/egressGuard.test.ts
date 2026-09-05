import test from "node:test";
import assert from "node:assert/strict";
import { validateEgressUrl, assertSafeEgress } from "../connectors/egressGuard.js";

test("validateEgressUrl rejects localhost and reserved IPs", () => {
  const blocked = [
    "http://localhost:4000",
    "http://127.0.0.1/",
    "http://10.0.0.1/",
    "http://169.254.169.254/",
    "http://192.168.1.1/",
    "http://metadata.google.internal/",
  ];

  for (const url of blocked) {
    const r = validateEgressUrl(url);
    assert.equal(r.ok, false, `expected blocked: ${url}`);
  }
});

test("validateEgressUrl allows mock://local", () => {
  const r = validateEgressUrl("mock://local");
  assert.equal(r.ok, true);
});

test("assertSafeEgress rejects DNS rebinding to private ranges (IP literals)", async () => {
  await assert.rejects(() => assertSafeEgress("http://127.0.0.1/"), /not allowed|blocked/i);
  await assert.rejects(() => assertSafeEgress("http://169.254.169.254/"), /not allowed|blocked/i);
});

test("assertSafeEgress allows public HTTPS hostnames", async () => {
  // Use example.com (stable public hostname). In production we additionally require https.
  await assertSafeEgress("https://example.com/");
});

