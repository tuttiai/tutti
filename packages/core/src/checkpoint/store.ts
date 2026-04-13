import type { Checkpoint } from "./types.js";

/**
 * Persistence contract for {@link Checkpoint} snapshots.
 *
 * Implementations MUST:
 * - treat `save` as "insert-or-replace by `(session_id, turn)`" so
 *   re-saving a turn overwrites rather than duplicates;
 * - return checkpoints ordered by ascending `turn` from `list`;
 * - return `null` (not throw) when nothing matches in `load` / `loadLatest`;
 * - remove every checkpoint for `session_id` in `delete`.
 */
export interface CheckpointStore {
  /** Insert-or-replace a checkpoint. Idempotent per `(session_id, turn)`. */
  save(checkpoint: Checkpoint): Promise<void>;
  /** Return the highest-turn checkpoint for `session_id`, or `null` if none. */
  loadLatest(session_id: string): Promise<Checkpoint | null>;
  /** Return the checkpoint at a specific turn, or `null` if none. */
  load(session_id: string, turn: number): Promise<Checkpoint | null>;
  /** Remove every checkpoint for `session_id`. No-op when none exist. */
  delete(session_id: string): Promise<void>;
  /** Return every checkpoint for `session_id`, sorted by ascending `turn`. */
  list(session_id: string): Promise<Checkpoint[]>;
}
