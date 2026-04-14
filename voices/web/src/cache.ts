import { createHash } from "node:crypto";
import { LRUCache } from "lru-cache";

/** Default TTL for search results (10 minutes). */
export const SEARCH_TTL_MS = 10 * 60 * 1_000;

/** Default TTL for fetched page content (30 minutes). */
export const FETCH_TTL_MS = 30 * 60 * 1_000;

/** Maximum number of cached entries. */
const MAX_ENTRIES = 500;

// V extends {} in lru-cache — use object | string | number | boolean
// to satisfy the constraint while keeping getCached/setCached generic.
type CacheValue = object | string | number | boolean;

const cache = new LRUCache<string, CacheValue>({
  max: MAX_ENTRIES,
  ttl: SEARCH_TTL_MS,
  allowStale: false,
});

/**
 * Build a cache key from one or more parts.
 *
 * @returns hex-encoded SHA-256 digest of the concatenated parts.
 */
export function cacheKey(...parts: string[]): string {
  return createHash("sha256").update(parts.join("|")).digest("hex");
}

/**
 * Retrieve a cached value, or `null` if absent / expired.
 */
export function getCached<T extends CacheValue>(key: string): T | null {
  const hit = cache.get(key);
  if (hit === undefined) return null;
  return hit as T;
}

/**
 * Store a value in the cache.
 *
 * @param key - Cache key (use {@link cacheKey} to derive).
 * @param value - Arbitrary serialisable value.
 * @param ttl - Per-entry TTL in ms. Falls back to the cache default.
 */
export function setCached<T extends CacheValue>(key: string, value: T, ttl?: number): void {
  cache.set(key, value, { ttl });
}

/**
 * Evict all entries. Useful in tests.
 */
export function clearCache(): void {
  cache.clear();
}
