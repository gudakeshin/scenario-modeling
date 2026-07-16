import test from "node:test";
import assert from "node:assert";
import { LruCache } from "./lruCache.js";

test("LruCache: evicts the oldest entry once maxEntries is exceeded", () => {
  const cache = new LruCache<string, number>({ maxEntries: 3 });
  cache.set("a", 1);
  cache.set("b", 2);
  cache.set("c", 3);
  cache.set("d", 4); // evicts "a" (oldest, untouched)

  assert.strictEqual(cache.has("a"), false);
  assert.strictEqual(cache.get("a"), undefined);
  assert.strictEqual(cache.get("b"), 2);
  assert.strictEqual(cache.get("c"), 3);
  assert.strictEqual(cache.get("d"), 4);
  assert.strictEqual(cache.size, 3);
});

test("LruCache: get refreshes recency so it survives eviction", () => {
  const cache = new LruCache<string, number>({ maxEntries: 3 });
  cache.set("a", 1);
  cache.set("b", 2);
  cache.set("c", 3);

  // Touch "a" so it becomes most-recently-used; "b" is now the oldest.
  assert.strictEqual(cache.get("a"), 1);

  cache.set("d", 4); // should evict "b", not "a"

  assert.strictEqual(cache.has("b"), false);
  assert.strictEqual(cache.get("a"), 1);
  assert.strictEqual(cache.get("c"), 3);
  assert.strictEqual(cache.get("d"), 4);
});

test("LruCache: re-setting an existing key refreshes its recency", () => {
  const cache = new LruCache<string, number>({ maxEntries: 2 });
  cache.set("a", 1);
  cache.set("b", 2);
  cache.set("a", 10); // "a" becomes most-recent; "b" is now oldest

  cache.set("c", 3); // evicts "b"

  assert.strictEqual(cache.has("b"), false);
  assert.strictEqual(cache.get("a"), 10);
  assert.strictEqual(cache.get("c"), 3);
});

test("LruCache: TTL expiry treats a stale entry as a miss", async () => {
  const cache = new LruCache<string, number>({ maxEntries: 10, ttlMs: 20 });
  cache.set("a", 1);
  assert.strictEqual(cache.get("a"), 1);

  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.strictEqual(cache.get("a"), undefined);
  assert.strictEqual(cache.has("a"), false);
  assert.strictEqual(cache.size, 0);
});

test("LruCache: per-entry TTL override takes precedence over the default", async () => {
  const cache = new LruCache<string, number>({ maxEntries: 10, ttlMs: 1000 });
  cache.set("short", 1, 10);
  cache.set("long", 2);

  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.strictEqual(cache.get("short"), undefined);
  assert.strictEqual(cache.get("long"), 2);
});

test("LruCache: delete and clear remove entries", () => {
  const cache = new LruCache<string, number>({ maxEntries: 5 });
  cache.set("a", 1);
  cache.set("b", 2);

  assert.strictEqual(cache.delete("a"), true);
  assert.strictEqual(cache.has("a"), false);
  assert.strictEqual(cache.size, 1);

  cache.clear();
  assert.strictEqual(cache.size, 0);
  assert.strictEqual(cache.has("b"), false);
});

test("LruCache: constructor rejects non-positive maxEntries", () => {
  assert.throws(() => new LruCache({ maxEntries: 0 }));
  assert.throws(() => new LruCache({ maxEntries: -1 }));
});
