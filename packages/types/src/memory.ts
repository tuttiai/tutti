/**
 * Semantic (long-term) memory — facts agents remember across sessions.
 *
 * Session memory = conversation history within a session.
 * Semantic memory = persistent facts that survive across sessions.
 *
 * Two surfaces consume this store:
 *
 * - The runtime auto-injects relevant entries into the system prompt at
 *   the start of each turn (see `agent.memory.semantic.inject_system`).
 * - The agent itself can call the curated `remember` / `recall` /
 *   `forget` tools when `agent.memory.semantic.curated_tools !== false`.
 *   Entries written through those tools carry `source: "agent"` so
 *   consumers can distinguish self-curated facts from system-injected
 *   ones.
 */

/** A single semantic memory entry. */
export interface MemoryEntry {
  id: string;
  agent_name: string;
  content: string;
  metadata: Record<string, unknown>;
  created_at: Date;
  /**
   * Last time this entry was returned by `search()` or explicitly
   * `touch()`-ed. Drives true-LRU eviction when an agent's
   * `max_entries_per_agent` cap is exceeded — the entry with the
   * oldest `last_accessed_at` is evicted first. Stores that haven't
   * been migrated to track this field may leave it `undefined`; the
   * eviction code treats `undefined` as "never accessed" and falls
   * back to `created_at`.
   */
  last_accessed_at?: Date;
  /**
   * Provenance of the entry. `"agent"` = written via the curated
   * `remember` tool by the agent itself. `"system"` = written by
   * runtime / orchestrator code. Older entries created before this
   * field existed may leave it `undefined`.
   */
  source?: "agent" | "system";
  /**
   * Free-form labels the agent (or a system writer) attaches to the
   * entry for later filtering. `search()` accepts a `tags` filter to
   * narrow results. Values are matched literally — case-sensitive,
   * no wildcarding.
   */
  tags?: string[];
}

/** Optional filters applied by {@link SemanticMemoryStore.search}. */
export interface SemanticSearchOptions {
  /** Restrict results to entries whose `source` matches. */
  source?: "agent" | "system";
  /**
   * Restrict results to entries that contain *every* listed tag.
   * Empty array is treated as "no tag filter".
   */
  tags?: string[];
}

export interface SemanticMemoryStore {
  /** Store a new memory entry. Returns the entry with generated id and timestamp. */
  add(
    entry: Omit<MemoryEntry, "id" | "created_at" | "last_accessed_at">,
  ): Promise<MemoryEntry>;

  /**
   * Search for relevant memories by keyword overlap. Returns top N by
   * relevance. Implementations MUST update `last_accessed_at` on every
   * returned entry so true-LRU eviction has accurate access timestamps.
   */
  search(
    query: string,
    agent_name: string,
    limit?: number,
    options?: SemanticSearchOptions,
  ): Promise<MemoryEntry[]>;

  /**
   * Enumerate every entry stored for an agent, regardless of relevance.
   * Used by per-agent cap enforcement to find the LRU eviction
   * candidate. Returned order is unspecified — callers must sort.
   */
  listByAgent(agent_name: string): Promise<MemoryEntry[]>;

  /**
   * Bump an entry's `last_accessed_at` to now without performing a
   * search. Used when the runtime injects an entry into the system
   * prompt directly so its access timestamp reflects actual usage.
   * No-op when the id is unknown.
   */
  touch(id: string): Promise<void>;

  /** Delete a single memory by ID. */
  delete(id: string): Promise<void>;

  /** Clear all memories for a specific agent. */
  clear(agent_name: string): Promise<void>;
}
