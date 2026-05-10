import { randomUUID } from "node:crypto";
import type {
  MemoryEntry,
  SemanticMemoryStore,
  SemanticSearchOptions,
} from "@tuttiai/types";

/**
 * In-memory semantic memory store using keyword overlap scoring.
 *
 * `search()` tokenises both the query and each stored entry into
 * words, then scores by the number of overlapping tokens — no
 * embeddings, simple and predictable for v1. Returned entries have
 * their `last_accessed_at` bumped to now so true-LRU eviction in the
 * runtime sees accurate access timestamps.
 */
export class InMemorySemanticStore implements SemanticMemoryStore {
  private entries: MemoryEntry[] = [];

  add(
    entry: Omit<MemoryEntry, "id" | "created_at" | "last_accessed_at">,
  ): Promise<MemoryEntry> {
    const now = new Date();
    const full: MemoryEntry = {
      ...entry,
      id: randomUUID(),
      created_at: now,
      last_accessed_at: now,
    };
    this.entries.push(full);
    return Promise.resolve(full);
  }

  search(
    query: string,
    agent_name: string,
    limit = 5,
    options?: SemanticSearchOptions,
  ): Promise<MemoryEntry[]> {
    const queryTokens = tokenize(query);
    if (queryTokens.size === 0) return Promise.resolve([]);

    const tagFilter = options?.tags && options.tags.length > 0
      ? new Set(options.tags)
      : undefined;
    const sourceFilter = options?.source;

    const candidates = this.entries.filter((e) => {
      if (e.agent_name !== agent_name) return false;
      if (sourceFilter && e.source !== sourceFilter) return false;
      if (tagFilter) {
        const entryTags = e.tags ?? [];
        for (const t of tagFilter) {
          if (!entryTags.includes(t)) return false;
        }
      }
      return true;
    });

    const scored = candidates.map((entry) => {
      const entryTokens = tokenize(entry.content);
      let overlap = 0;
      for (const token of queryTokens) {
        if (entryTokens.has(token)) overlap++;
      }
      const score = overlap / queryTokens.size;
      return { entry, score };
    });

    const hits = scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => s.entry);

    const now = new Date();
    for (const e of hits) e.last_accessed_at = now;

    return Promise.resolve(hits);
  }

  listByAgent(agent_name: string): Promise<MemoryEntry[]> {
    return Promise.resolve(this.entries.filter((e) => e.agent_name === agent_name));
  }

  touch(id: string): Promise<void> {
    const entry = this.entries.find((e) => e.id === id);
    if (entry) entry.last_accessed_at = new Date();
    return Promise.resolve();
  }

  delete(id: string): Promise<void> {
    this.entries = this.entries.filter((e) => e.id !== id);
    return Promise.resolve();
  }

  clear(agent_name: string): Promise<void> {
    this.entries = this.entries.filter((e) => e.agent_name !== agent_name);
    return Promise.resolve();
  }
}

/** Normalise text into a set of lowercase tokens, stripping punctuation. */
function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 1),
  );
}
