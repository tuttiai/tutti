import { randomUUID } from "node:crypto";
import type { MemoryEntry, SemanticMemoryStore } from "./semantic.js";

/**
 * In-memory semantic memory store using keyword overlap scoring.
 *
 * search() tokenises both the query and each stored entry into words,
 * then scores by the number of overlapping tokens. No embeddings
 * needed — simple and predictable for v1.
 */
export class InMemorySemanticStore implements SemanticMemoryStore {
  private entries: MemoryEntry[] = [];

  add(
    entry: Omit<MemoryEntry, "id" | "created_at">,
  ): Promise<MemoryEntry> {
    const full: MemoryEntry = {
      ...entry,
      id: randomUUID(),
      created_at: new Date(),
    };
    this.entries.push(full);
    return Promise.resolve(full);
  }

  search(
    query: string,
    agent_name: string,
    limit = 5,
  ): Promise<MemoryEntry[]> {
    const queryTokens = tokenize(query);
    if (queryTokens.size === 0) return Promise.resolve([]);

    const agentEntries = this.entries.filter(
      (e) => e.agent_name === agent_name,
    );

    const scored = agentEntries.map((entry) => {
      const entryTokens = tokenize(entry.content);
      let overlap = 0;
      for (const token of queryTokens) {
        if (entryTokens.has(token)) overlap++;
      }
      const score = overlap / queryTokens.size;
      return { entry, score };
    });

    return Promise.resolve(
      scored
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((s) => s.entry),
    );
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
