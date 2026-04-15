import { randomUUID } from "node:crypto";

import type {
  StoreOptions,
  UserMemory,
  UserMemoryImportance,
  UserMemorySource,
  UserMemoryStore,
} from "./types.js";

/** Default per-user cap when `AgentUserMemoryConfig.max_memories_per_user` is unset. */
export const DEFAULT_MAX_MEMORIES_PER_USER = 200;
/** Default `source` applied to {@link UserMemoryStore.store} calls. */
const DEFAULT_SOURCE: UserMemorySource = "explicit";
/** Default `importance` applied to {@link UserMemoryStore.store} calls. */
const DEFAULT_IMPORTANCE: UserMemoryImportance = 2;

/** Construction options for {@link MemoryUserMemoryStore}. */
export interface MemoryUserMemoryStoreOptions {
  /** Per-user cap. Defaults to {@link DEFAULT_MAX_MEMORIES_PER_USER}. */
  max_memories_per_user?: number;
}

/**
 * In-memory {@link UserMemoryStore} backed by a `Map<user_id, UserMemory[]>`.
 *
 * Suitable for tests, local dev, and ephemeral demos. **Do not use in
 * production** — memories are lost on process restart and stored in
 * plaintext (no encryption at rest, no access control beyond the
 * `user_id` keying).
 *
 * Search is a case-insensitive substring match on `content`, ranked by
 * `importance DESC, created_at DESC`. Good enough for development feedback
 * loops; the Postgres backend uses trigram similarity for production.
 *
 * When the per-user cap is exceeded the store evicts the worst memories
 * first — lowest `importance`, then oldest `created_at` within that band.
 */
export class MemoryUserMemoryStore implements UserMemoryStore {
  private readonly byUser = new Map<string, UserMemory[]>();
  private readonly maxMemoriesPerUser: number;

  constructor(options: MemoryUserMemoryStoreOptions = {}) {
    this.maxMemoriesPerUser =
      options.max_memories_per_user ?? DEFAULT_MAX_MEMORIES_PER_USER;
  }

  store(
    user_id: string,
    content: string,
    options: StoreOptions = {},
  ): Promise<UserMemory> {
    const memory: UserMemory = {
      id: randomUUID(),
      user_id,
      content,
      source: options.source ?? DEFAULT_SOURCE,
      importance: options.importance ?? DEFAULT_IMPORTANCE,
      ...(options.tags !== undefined ? { tags: options.tags } : {}),
      created_at: new Date(),
      ...(options.expires_at !== undefined ? { expires_at: options.expires_at } : {}),
    };

    const list = this.byUser.get(user_id) ?? [];
    list.push(memory);
    this.byUser.set(user_id, list);
    this.enforceCap(user_id);

    return Promise.resolve(memory);
  }

  search(
    user_id: string,
    query: string,
    limit = 10,
  ): Promise<UserMemory[]> {
    const trimmed = query.trim();
    if (trimmed === "") return Promise.resolve([]);

    const needle = trimmed.toLowerCase();
    const candidates = (this.byUser.get(user_id) ?? []).filter(
      (m) => !this.isExpired(m) && m.content.toLowerCase().includes(needle),
    );

    const ranked = candidates
      .sort(byImportanceDescThenCreatedAtDesc)
      .slice(0, limit);

    // Bump last_accessed_at on every returned row — drives recency-aware
    // tie-breaking for stores that key on it later (e.g. Postgres).
    const now = new Date();
    for (const m of ranked) m.last_accessed_at = now;

    return Promise.resolve(ranked);
  }

  list(user_id: string): Promise<UserMemory[]> {
    const memories = (this.byUser.get(user_id) ?? []).filter(
      (m) => !this.isExpired(m),
    );
    // Stable ordering: most-recently-created first.
    return Promise.resolve(
      [...memories].sort((a, b) => b.created_at.getTime() - a.created_at.getTime()),
    );
  }

  delete(id: string): Promise<void> {
    for (const [user_id, list] of this.byUser) {
      const next = list.filter((m) => m.id !== id);
      if (next.length !== list.length) {
        if (next.length === 0) this.byUser.delete(user_id);
        else this.byUser.set(user_id, next);
        return Promise.resolve();
      }
    }
    // No-op when id is unknown — idempotent on purpose so callers can
    // treat this as a cleanup primitive without first checking existence.
    return Promise.resolve();
  }

  deleteAll(user_id: string): Promise<void> {
    this.byUser.delete(user_id);
    return Promise.resolve();
  }

  get(id: string): Promise<UserMemory | null> {
    for (const list of this.byUser.values()) {
      const found = list.find((m) => m.id === id);
      if (found) {
        if (this.isExpired(found)) return Promise.resolve(null);
        found.last_accessed_at = new Date();
        return Promise.resolve(found);
      }
    }
    return Promise.resolve(null);
  }

  /**
   * Evict the worst memories until the per-user count is back at the cap.
   * "Worst" = lowest importance, then oldest within that importance band.
   */
  private enforceCap(user_id: string): void {
    const list = this.byUser.get(user_id);
    if (!list || list.length <= this.maxMemoriesPerUser) return;

    const overage = list.length - this.maxMemoriesPerUser;
    const toEvict = new Set(
      [...list]
        .sort((a, b) => {
          if (a.importance !== b.importance) return a.importance - b.importance;
          return a.created_at.getTime() - b.created_at.getTime();
        })
        .slice(0, overage)
        .map((m) => m.id),
    );

    this.byUser.set(
      user_id,
      list.filter((m) => !toEvict.has(m.id)),
    );
  }

  private isExpired(m: UserMemory): boolean {
    return m.expires_at !== undefined && m.expires_at.getTime() <= Date.now();
  }
}

function byImportanceDescThenCreatedAtDesc(
  a: UserMemory,
  b: UserMemory,
): number {
  if (a.importance !== b.importance) return b.importance - a.importance;
  return b.created_at.getTime() - a.created_at.getTime();
}
