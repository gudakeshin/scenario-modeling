/**
 * LruCache — small, dependency-free bounded cache.
 *
 * Backed by a single `Map`, whose keys iterate in insertion order. Recency
 * is maintained by deleting + re-inserting a key on every `get`/`set` hit,
 * so the least-recently-used entry is always the first one the iterator
 * yields. When the cache exceeds `maxEntries`, that first entry is evicted.
 *
 * An optional per-entry TTL (ms) makes stale entries read back as misses
 * without needing a background sweep — expiry is checked lazily on access.
 */

interface Entry<V> {
  value: V;
  expiresAt: number | null;
}

export interface LruCacheOptions {
  /** Maximum number of live entries before the least-recently-used one is evicted. */
  maxEntries: number;
  /** Optional default time-to-live for entries, in milliseconds. */
  ttlMs?: number;
}

export class LruCache<K, V> {
  private readonly map = new Map<K, Entry<V>>();
  private readonly maxEntries: number;
  private readonly ttlMs: number | undefined;

  constructor(options: LruCacheOptions) {
    if (!Number.isFinite(options.maxEntries) || options.maxEntries <= 0) {
      throw new Error("LruCache: maxEntries must be a positive number");
    }
    this.maxEntries = Math.floor(options.maxEntries);
    this.ttlMs = options.ttlMs;
  }

  get size(): number {
    return this.map.size;
  }

  /** Returns the cached value, or undefined on miss/expiry. Refreshes recency on hit. */
  get(key: K): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt != null && entry.expiresAt <= Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    // Refresh recency: delete + re-insert so this key becomes the most recent.
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  /** True when the key is present and not expired. Does not refresh recency. */
  has(key: K): boolean {
    const entry = this.map.get(key);
    if (!entry) return false;
    if (entry.expiresAt != null && entry.expiresAt <= Date.now()) {
      this.map.delete(key);
      return false;
    }
    return true;
  }

  set(key: K, value: V, ttlMsOverride?: number): void {
    // Remove first so a re-set of an existing key moves it to most-recent position.
    this.map.delete(key);
    const ttl = ttlMsOverride ?? this.ttlMs;
    this.map.set(key, { value, expiresAt: ttl != null ? Date.now() + ttl : null });
    this.evictIfNeeded();
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  private evictIfNeeded(): void {
    while (this.map.size > this.maxEntries) {
      const oldestKey = this.map.keys().next().value as K | undefined;
      if (oldestKey === undefined) break;
      this.map.delete(oldestKey);
    }
  }
}
