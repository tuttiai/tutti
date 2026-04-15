import type { GoldenCase, GoldenRun } from "./types.js";

/**
 * Pluggable backend for golden cases and their recorded runs.
 *
 * Implementations include {@link JsonFileGoldenStore} (local `.tutti/golden/`
 * JSON files — the default) and may later grow Postgres / S3 variants.
 *
 * Method semantics:
 *
 * - `saveCase` — insert-or-replace by `id`. When `case.id` is blank the
 *   store assigns a fresh id and returns the stored record. `created_at`
 *   is preserved across updates if already set; filled in on first save.
 * - `getCase` / `getRun` — direct lookup; returns `null` (not throws) when
 *   the id is unknown so callers can distinguish absence from error.
 * - `listCases` — every case, sorted by `created_at` ascending (oldest
 *   first) — matches how CI will usually want to print them.
 * - `deleteCase` — removes the case AND its recorded runs. No-op for
 *   unknown ids. Idempotent.
 * - `saveRun` — insert-or-replace by `id`, appending to the case's run
 *   history when new. Fills in a fresh id when `run.id` is blank.
 * - `listRuns` — every run for the given `case_id`, sorted by `ran_at`
 *   ascending. Empty array for unknown case ids.
 * - `latestRun` — the most recent run for `case_id`, or `null` when the
 *   case has no recorded runs.
 */
export interface GoldenStore {
  /** Insert or replace a golden case. Returns the stored record. */
  saveCase(golden_case: GoldenCase): Promise<GoldenCase>;
  /** Return the case with this id, or `null`. */
  getCase(id: string): Promise<GoldenCase | null>;
  /** Return every case, oldest first. */
  listCases(): Promise<GoldenCase[]>;
  /** Remove a case and its runs. No-op for unknown ids. */
  deleteCase(id: string): Promise<void>;

  /** Insert or replace a recorded run. Returns the stored record. */
  saveRun(run: GoldenRun): Promise<GoldenRun>;
  /** Return the run with this id, or `null`. Scans across cases. */
  getRun(id: string): Promise<GoldenRun | null>;
  /** Return every run for this case, oldest first. */
  listRuns(case_id: string): Promise<GoldenRun[]>;
  /** Return the most recent run for this case, or `null`. */
  latestRun(case_id: string): Promise<GoldenRun | null>;
}
