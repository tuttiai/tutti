import type { CheckpointStore } from "./store.js";
import type { Checkpoint } from "./types.js";

/**
 * In-memory {@link CheckpointStore} — **test-only**.
 *
 * Suitable for unit tests, examples, and exploratory scripts. Not durable
 * across process restarts, not thread-safe across worker threads, and not
 * bounded — every checkpoint is retained until {@link delete} is called.
 * Use `RedisCheckpointStore` / `PostgresCheckpointStore` in production.
 *
 * Inputs and outputs are deep-cloned with `structuredClone` so callers
 * can't accidentally mutate persisted state (or vice-versa) by holding a
 * reference to the same object. This matches how a real durable store
 * behaves after serialisation.
 */
export class MemoryCheckpointStore implements CheckpointStore {
  // session_id → turn → Checkpoint. Nested Map keeps per-session lookups
  // O(1) and lets `delete` drop an entire session in one call.
  private readonly store = new Map<string, Map<number, Checkpoint>>();

  save(checkpoint: Checkpoint): Promise<void> {
    let bySession = this.store.get(checkpoint.session_id);
    if (!bySession) {
      bySession = new Map();
      this.store.set(checkpoint.session_id, bySession);
    }
    bySession.set(checkpoint.turn, structuredClone(checkpoint));
    return Promise.resolve();
  }

  loadLatest(session_id: string): Promise<Checkpoint | null> {
    const bySession = this.store.get(session_id);
    if (!bySession || bySession.size === 0) return Promise.resolve(null);
    let latest: Checkpoint | undefined;
    for (const cp of bySession.values()) {
      if (!latest || cp.turn > latest.turn) latest = cp;
    }
    return Promise.resolve(latest ? structuredClone(latest) : null);
  }

  load(session_id: string, turn: number): Promise<Checkpoint | null> {
    const cp = this.store.get(session_id)?.get(turn);
    return Promise.resolve(cp ? structuredClone(cp) : null);
  }

  delete(session_id: string): Promise<void> {
    this.store.delete(session_id);
    return Promise.resolve();
  }

  list(session_id: string): Promise<Checkpoint[]> {
    const bySession = this.store.get(session_id);
    if (!bySession) return Promise.resolve([]);
    const sorted = Array.from(bySession.values())
      .slice()
      .sort((a, b) => a.turn - b.turn)
      .map((cp) => structuredClone(cp));
    return Promise.resolve(sorted);
  }
}
