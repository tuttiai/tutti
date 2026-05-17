/**
 * Type definitions for the Tutti scheduler engine.
 */

import type { ScheduleDeliveryTarget } from "@tuttiai/types";

/**
 * Schedule configuration — attach to an agent to run it automatically.
 *
 * Exactly one of `cron`, `every`, or `at` must be provided.
 *
 * Mirrors {@link import("@tuttiai/types").AgentScheduleConfig} — the engine
 * uses this internal shape so the scheduler doesn't need to round-trip
 * through the public type surface. Keep the two in lockstep.
 */
export interface ScheduleConfig {
  /** Cron expression (5-field). E.g. `"0 9 * * *"` = 9 AM daily. */
  cron?: string;
  /** Interval shorthand. E.g. `"1h"`, `"30m"`, `"5s"`, `"2d"`. */
  every?: string;
  /** One-shot ISO-8601 datetime. The agent runs once at this time. */
  at?: string;
  /** Input string passed to the agent on each triggered run. */
  input: string;
  /** Auto-disable the schedule after this many runs. */
  max_runs?: number;
  /**
   * Optional delivery target — when set, the agent's output is dispatched
   * to the platform after each successful run.
   */
  deliver?: ScheduleDeliveryTarget;
  /** Output format for delivery. Default `"text"`. */
  deliver_format?: "text" | "markdown";
}

/**
 * Record of a single triggered run of a scheduled agent.
 */
export interface ScheduledRun {
  /** ID of the schedule that triggered this run. */
  schedule_id: string;
  /** Agent name/ID that was executed. */
  agent_id: string;
  /** When the run was triggered. */
  triggered_at: Date;
  /** When the run finished (absent if still running or failed before completion). */
  completed_at?: Date;
  /** Agent text output on success. */
  result?: string;
  /** Error message on failure. */
  error?: string;
}

/**
 * Persisted schedule record — the full state of a registered schedule.
 */
export interface ScheduleRecord {
  /** Unique schedule identifier. */
  id: string;
  /** Agent name/ID this schedule triggers. */
  agent_id: string;
  /** The schedule configuration. */
  config: ScheduleConfig;
  /** Whether the schedule is active. `false` after max_runs or manual pause. */
  enabled: boolean;
  /** When the schedule was first registered. */
  created_at: Date;
  /** Next computed run time (informational). */
  next_run_at?: Date;
  /** Total runs completed so far. */
  run_count: number;
}
