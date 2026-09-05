/**
 * Rate-limit store selection — verifies we pick the Redis-backed store when
 * a Redis client is available and fall back to express-rate-limit's default
 * MemoryStore (by returning undefined) otherwise. No real Redis server is
 * spun up: the Redis client factory is injected so both branches are
 * exercised deterministically.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { RedisStore } from "rate-limit-redis";
import { createRateLimitStore } from "./rateLimitStore.js";

test("createRateLimitStore falls back to MemoryStore (undefined) when Redis is unavailable", async () => {
  const store = await createRateLimitStore("sm:rl:test:", async () => null);
  assert.equal(store, undefined);
});

test("createRateLimitStore uses a Redis-backed store when a Redis client is available", async () => {
  const calls: string[][] = [];
  const fakeClient = {
    call: async (...args: string[]) => {
      calls.push(args);
      return 1;
    },
  };
  const store = await createRateLimitStore("sm:rl:test:", async () => fakeClient);
  assert.ok(store instanceof RedisStore);
});
