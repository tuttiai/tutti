import type { ScheduleRecord, ScheduledRun } from "./types.js";

/**
 * Persistence contract for schedule records.
 *
 * Implementations MUST:
 * - treat `save` as insert-or-replace by `id`;
 * - return `null` (not throw) when nothing matches in `get`;
 * - return records sorted by `created_at` ascending from `list`.
 */
export interface ScheduleStore {
  /** Insert or replace a schedule record. Idempotent per `id`. */
  save(record: ScheduleRecord): Promise<void>;
  /** Return the schedule with this ID, or `null`. */
  get(id: string): Promise<ScheduleRecord | null>;
  /** Return all schedule records, sorted by `created_at` ascending. */
  list(): Promise<ScheduleRecord[]>;
  /** Remove a schedule by ID. No-op when not found. */
  delete(id: string): Promise<void>;
  /** Append a completed run and increment the record's run_count. */
  addRun(id: string, run: ScheduledRun): Promise<void>;
  /** Enable or disable a schedule. */
  setEnabled(id: string, enabled: boolean): Promise<void>;
}
