/**
 * Semantic (long-term) memory — facts agents remember across sessions.
 *
 * Session memory = conversation history within a session.
 * Semantic memory = persistent facts that survive across sessions.
 *
 * Example: a user tells the coder agent "I prefer 2-space indentation".
 * Next session, the agent already knows this preference.
 */

export interface MemoryEntry {
  id: string;
  agent_name: string;
  content: string;
  metadata: Record<string, unknown>;
  created_at: Date;
}

export interface SemanticMemoryStore {
  /** Store a new memory entry. Returns the entry with generated id and timestamp. */
  add(
    entry: Omit<MemoryEntry, "id" | "created_at">,
  ): Promise<MemoryEntry>;

  /** Search for relevant memories by keyword overlap. Returns top N by relevance. */
  search(
    query: string,
    agent_name: string,
    limit?: number,
  ): Promise<MemoryEntry[]>;

  /** Delete a single memory by ID. */
  delete(id: string): Promise<void>;

  /** Clear all memories for a specific agent. */
  clear(agent_name: string): Promise<void>;
}
