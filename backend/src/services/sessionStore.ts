/**
 * Pluggable session store — Memory (default) or Redis when REDIS_URL is set.
 * Enables horizontal scaling of conversational sessions.
 */

import { config } from "../config.js";
import { logger } from "../logger.js";

export interface StoredSession {
  scenario_id: string;
  user_id: string;
  turns: { role: "user" | "assistant"; content: string; timestamp: string }[];
  expires_at: number;
  created_at: number;
}

export interface SessionStore {
  get(sessionId: string): Promise<StoredSession | null>;
  set(sessionId: string, session: StoredSession, ttlMs: number): Promise<void>;
  delete(sessionId: string): Promise<boolean>;
  list(userId?: string): Promise<Array<{ id: string; session: StoredSession }>>;
  cleanExpired(): Promise<void>;
}

export class MemorySessionStore implements SessionStore {
  private map = new Map<string, StoredSession>();

  async get(sessionId: string): Promise<StoredSession | null> {
    await this.cleanExpired();
    return this.map.get(sessionId) ?? null;
  }

  async set(sessionId: string, session: StoredSession, _ttlMs?: number): Promise<void> {
    this.map.set(sessionId, session);
  }

  async delete(sessionId: string): Promise<boolean> {
    return this.map.delete(sessionId);
  }

  async list(userId?: string): Promise<Array<{ id: string; session: StoredSession }>> {
    await this.cleanExpired();
    const out: Array<{ id: string; session: StoredSession }> = [];
    for (const [id, session] of this.map) {
      if (userId && session.user_id !== userId) continue;
      out.push({ id, session });
    }
    return out;
  }

  async cleanExpired(): Promise<void> {
    const now = Date.now();
    for (const [id, s] of this.map) {
      if (now > s.expires_at) this.map.delete(id);
    }
  }
}

class RedisSessionStore implements SessionStore {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private client: any;
  private prefix = "sm:session:";
  private indexKey = "sm:sessions:index";

  constructor(redisUrl: string) {
    // Dynamic import pattern — constructed asynchronously via createSessionStore
    // but Redis constructor is sync once module is loaded.
    // We accept a pre-connected client.
    void redisUrl;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  attach(client: any): void {
    this.client = client;
  }

  private key(id: string): string {
    return `${this.prefix}${id}`;
  }

  async get(sessionId: string): Promise<StoredSession | null> {
    const raw = await this.client.get(this.key(sessionId));
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as StoredSession;
      if (Date.now() > parsed.expires_at) {
        await this.delete(sessionId);
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  async set(sessionId: string, session: StoredSession, ttlMs: number): Promise<void> {
    const ttlSec = Math.max(1, Math.ceil(ttlMs / 1000));
    await this.client.set(this.key(sessionId), JSON.stringify(session), "EX", ttlSec);
    await this.client.sadd(this.indexKey, sessionId);
  }

  async delete(sessionId: string): Promise<boolean> {
    const n = await this.client.del(this.key(sessionId));
    await this.client.srem(this.indexKey, sessionId);
    return n > 0;
  }

  async list(userId?: string): Promise<Array<{ id: string; session: StoredSession }>> {
    const ids: string[] = await this.client.smembers(this.indexKey);
    const out: Array<{ id: string; session: StoredSession }> = [];
    for (const id of ids) {
      const session = await this.get(id);
      if (!session) {
        await this.client.srem(this.indexKey, id);
        continue;
      }
      if (userId && session.user_id !== userId) continue;
      out.push({ id, session });
    }
    return out;
  }

  async cleanExpired(): Promise<void> {
    // Redis TTLs handle expiry; prune stale index entries
    const ids: string[] = await this.client.smembers(this.indexKey);
    for (const id of ids) {
      const exists = await this.client.exists(this.key(id));
      if (!exists) await this.client.srem(this.indexKey, id);
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type RedisClientLike = any;

let redisClientPromise: Promise<RedisClientLike | null> | null = null;

/**
 * Shared Redis connection factory — reused by SessionStore and anything else
 * that needs Redis (e.g. rate-limit stores) so a single process only ever
 * opens one Redis connection. Returns null when REDIS_URL is unset or the
 * connection fails; callers should fall back to an in-process alternative.
 */
export async function getRedisClient(): Promise<RedisClientLike | null> {
  if (!redisClientPromise) {
    redisClientPromise = (async () => {
      const url = config.REDIS_URL;
      if (!url) return null;
      try {
        const mod = await import("ioredis");
        // ioredis CJS/ESM interop — default may be the module namespace under NodeNext
        const RedisCtor = (mod as unknown as { default?: new (url: string, opts?: object) => unknown }).default
          ?? (mod as unknown as new (url: string, opts?: object) => unknown);
        const client = new RedisCtor(url, {
          maxRetriesPerRequest: 2,
          enableReadyCheck: true,
          lazyConnect: true,
        }) as { connect: () => Promise<void> };
        await client.connect();
        logger.info("[Redis] Connected (shared client)");
        return client as RedisClientLike;
      } catch (e) {
        logger.warn(
          { detail: (e as Error).message },
          "[Redis] Unavailable — falling back to in-process alternatives",
        );
        return null;
      }
    })();
  }
  return redisClientPromise;
}

/** Test helper — reset the shared Redis client singleton between tests. */
export function resetRedisClientForTests(): void {
  redisClientPromise = null;
}

let storePromise: Promise<SessionStore> | null = null;

export async function getSessionStore(): Promise<SessionStore> {
  if (!storePromise) {
    storePromise = (async () => {
      const url = config.REDIS_URL;
      if (!url) {
        logger.info("[SessionStore] Using in-memory store (set REDIS_URL for Redis)");
        return new MemorySessionStore();
      }
      const client = await getRedisClient();
      if (!client) {
        logger.warn("[SessionStore] Redis unavailable — falling back to memory");
        return new MemorySessionStore();
      }
      const redisStore = new RedisSessionStore(url);
      redisStore.attach(client);
      logger.info("[SessionStore] Connected to Redis");
      return redisStore;
    })();
  }
  return storePromise;
}

/** Test helper — reset singleton between tests. */
export function resetSessionStoreForTests(): void {
  storePromise = null;
}
