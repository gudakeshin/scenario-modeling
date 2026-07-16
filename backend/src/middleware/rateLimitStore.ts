/**
 * Rate-limit store selection — Redis-backed when REDIS_URL is configured so
 * limits are shared across horizontally-scaled instances, otherwise falls
 * back to express-rate-limit's in-process MemoryStore (single-instance/dev).
 *
 * Reuses the shared Redis connection factory from sessionStore.ts rather
 * than opening a second Redis client per process.
 */
import { RedisStore } from "rate-limit-redis";
import type { Store } from "express-rate-limit";
import { getRedisClient, type RedisClientLike } from "../services/sessionStore.js";
import { logger } from "../logger.js";

/**
 * Returns a Redis-backed rate-limit Store when Redis is available, or
 * `undefined` to let express-rate-limit fall back to its default
 * MemoryStore. `undefined` — not a constructed MemoryStore — is intentional:
 * each limiter should get its own MemoryStore instance so counts for
 * different limiters (auth vs general API) don't collide.
 *
 * `getClient` is injectable for tests (defaults to the shared Redis
 * connection factory from sessionStore.ts) so store-selection logic can be
 * verified without a real Redis server.
 */
export async function createRateLimitStore(
  prefix: string,
  getClient: () => Promise<RedisClientLike | null> = getRedisClient,
): Promise<Store | undefined> {
  const client = await getClient();
  if (!client) {
    logger.info(
      { prefix },
      "[RateLimit] Using in-memory store (set REDIS_URL to share limits across instances)",
    );
    return undefined;
  }
  logger.info({ prefix }, "[RateLimit] Using Redis-backed store");
  return new RedisStore({
    sendCommand: (...args: string[]) => client.call(...args),
    prefix,
  });
}
