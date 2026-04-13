/**
 * Bounded in-memory implementation of {@link ToolCache} with TTL + LRU
 * eviction. Keys are `sha256(tool + '|' + JSON.stringify(input))` — stable
 * for equivalent inputs across processes, opaque to callers.
 *
 * Designed for hot-path use inside the agent loop: all operations are O(1)
 * amortized against an insertion-ordered `Map`.
 */

import { createHash } from "node:crypto";
import type { ToolResult } from "@tuttiai/types";
import type { ToolCache } from "./tool-cache.js";

/** Default per-entry TTL: 5 minutes. */
export const DEFAULT_CACHE_TTL_MS = 300_000;

/** Default cap on stored entries before LRU eviction kicks in. */
export const DEFAULT_CACHE_MAX_ENTRIES = 1000;

export interface InMemoryToolCacheOptions {
  /** Default TTL for entries that don't specify one (default: 5 minutes). */
  default_ttl_ms?: number;
  /** Maximum number of entries to retain (default: 1000). */
  max_entries?: number;
}

interface CacheEntry {
  result: ToolResult;
  expires_at: number;
  /** Plain tool name — kept so `invalidate(tool)` can scan without re-hashing. */
  tool: string;
}

/**
 * Hash `(tool, input)` into a stable cache key. We separate the tool name
 * from the JSON with a pipe so `{tool: "a|b", input: {}}` and
 * `{tool: "a", input: "|b"}` can't collide.
 */
function hashKey(tool: string, input: unknown): string {
  const payload = `${tool}|${JSON.stringify(input) ?? "null"}`;
  return createHash("sha256").update(payload).digest("hex");
}

/**
 * Bounded, TTL-aware, LRU in-memory tool cache.
 *
 * @example
 *   const cache = new InMemoryToolCache({ default_ttl_ms: 60_000 });
 *   await cache.set("read_file", { path: "README.md" }, { content: "..." });
 *   const hit = await cache.get("read_file", { path: "README.md" });
 */
export class InMemoryToolCache implements ToolCache {
  private readonly defaultTtlMs: number;
  private readonly maxEntries: number;
  private readonly store = new Map<string, CacheEntry>();

  constructor(options: InMemoryToolCacheOptions = {}) {
    this.defaultTtlMs = options.default_ttl_ms ?? DEFAULT_CACHE_TTL_MS;
    this.maxEntries = options.max_entries ?? DEFAULT_CACHE_MAX_ENTRIES;
  }

  // Methods return `Promise` to satisfy the ToolCache interface (which must
  // support async implementations like Redis) even though this impl is sync.
  // eslint-disable-next-line @typescript-eslint/require-await
  async get(tool: string, input: unknown): Promise<ToolResult | null> {
    const key = hashKey(tool, input);
    const entry = this.store.get(key);
    if (!entry) return null;

    if (Date.now() >= entry.expires_at) {
      this.store.delete(key);
      return null;
    }

    // Touch: re-insert so this key becomes most-recently-used.
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.result;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async set(
    tool: string,
    input: unknown,
    result: ToolResult,
    ttl_ms?: number,
  ): Promise<void> {
    const key = hashKey(tool, input);
    const ttl = ttl_ms ?? this.defaultTtlMs;
    const entry: CacheEntry = {
      result,
      expires_at: Date.now() + ttl,
      tool,
    };

    // Overwrite also re-orders for LRU — remove first so Map re-inserts at end.
    this.store.delete(key);
    this.store.set(key, entry);

    // Evict least-recently-used entries until we're back under capacity.
    while (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) break;
      this.store.delete(oldest);
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async invalidate(tool: string, input?: unknown): Promise<void> {
    if (input !== undefined) {
      this.store.delete(hashKey(tool, input));
      return;
    }
    // Full tool scan — O(n) but rare (manual invalidation path).
    for (const [key, entry] of this.store) {
      if (entry.tool === tool) this.store.delete(key);
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async clear(): Promise<void> {
    this.store.clear();
  }

  /** Current number of live entries (test / telemetry helper). */
  get size(): number {
    return this.store.size;
  }
}
