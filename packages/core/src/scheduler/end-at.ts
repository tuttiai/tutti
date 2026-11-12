/**
 * Stop rules for the scheduler engine: the optional `end_at` end time
 * and `max_runs`. Internal to the scheduler; not exported from the
 * package index.
 */

import { z } from "zod";
import type { AgentScheduleConfig } from "@tuttiai/types";
import type { ScheduleConfig, ScheduleRecord } from "./types.js";

/** Longest delay `setTimeout` honours; a longer one fires at once. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

const IsoDateTimeSchema = z.string().datetime({ offset: true });

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/**
 * Compile-time guard: `tsc` fails here when the engine's
 * {@link ScheduleConfig} and the public `AgentScheduleConfig` drift apart.
 */
export const CONFIGS_IN_STEP: Equals<ScheduleConfig, AgentScheduleConfig> = true;

/** Why a schedule is being disabled, as a log message plus log fields. */
export interface StopReason {
  message: string;
  fields: Record<string, unknown>;
}

/**
 * True when `value` is an ISO-8601 date-time with a timezone (`Z` or an
 * offset such as `+01:00`). A bare date or a time with no zone is false.
 */
export function isIsoDateTime(value: string): boolean {
  return IsoDateTimeSchema.safeParse(value).success;
}

/**
 * Check the shape of `config.end_at` against the clock.
 *
 * @returns `"open"` when there is no end_at or it is still ahead,
 *   `"passed"` when it is at or before `nowMs`.
 * @throws When end_at is not a valid date-time or is before `at`.
 */
export function endAtState(
  id: string,
  config: ScheduleConfig,
  nowMs: number,
): "open" | "passed" {
  const endAt = config.end_at;
  if (endAt === undefined) return "open";
  if (!isIsoDateTime(endAt)) {
    throw new Error(
      `Schedule "${id}": end_at must be an ISO-8601 date-time with a timezone, got "${endAt}".`,
    );
  }
  const endMs = Date.parse(endAt);
  if (config.at !== undefined && endMs < Date.parse(config.at)) {
    throw new Error(`Schedule "${id}": end_at "${endAt}" is before at "${config.at}".`);
  }
  return endMs <= nowMs ? "passed" : "open";
}

/** The error for a new schedule whose end_at is not after the start. */
export function pastEndAtError(id: string, config: ScheduleConfig, nowMs: number): Error {
  return new Error(
    `Schedule "${id}": end_at "${String(config.end_at)}" is not after the start ` +
      `(now, ${new Date(nowMs).toISOString()}). Remove or extend end_at.`,
  );
}

/** True once `nowMs` is past end_at. A run due exactly at end_at still fires. */
export function hasEnded(config: ScheduleConfig, nowMs: number): boolean {
  return config.end_at !== undefined && nowMs > Date.parse(config.end_at);
}

/** The reason to disable a schedule before a run, or `undefined` to run it. */
export function stopReason(record: ScheduleRecord, nowMs: number): StopReason | undefined {
  if (hasEnded(record.config, nowMs)) {
    return {
      message: "Schedule disabled: end_at reached",
      fields: { end_at: record.config.end_at },
    };
  }
  return maxRunsReason(record);
}

/** The reason to disable a schedule that has used up max_runs, if it has. */
export function maxRunsReason(record: ScheduleRecord): StopReason | undefined {
  const max = record.config.max_runs;
  if (max === undefined || record.run_count < max) return undefined;
  return {
    message: "Schedule disabled — max_runs reached",
    fields: { run_count: record.run_count, max_runs: max },
  };
}

/**
 * Call `onEnd` from a timer once the clock is past `endMs`. Waits longer
 * than {@link MAX_TIMER_DELAY_MS} are split into steps. `onEnd` never runs
 * synchronously, even when `endMs` has already passed.
 *
 * @returns A function that cancels the pending timer.
 */
export function armEndTimer(endMs: number, onEnd: () => void): () => void {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const arm = (): void => {
    const delay = Math.min(Math.max(endMs - Date.now() + 1, 0), MAX_TIMER_DELAY_MS);
    handle = setTimeout(() => {
      if (Date.now() > endMs) onEnd();
      else arm();
    }, delay);
  };
  arm();
  return () => clearTimeout(handle);
}

/**
 * Wrap a trigger timer's stop function so it also cancels the end timer,
 * arming one when `config.end_at` is set. Without end_at, returns `stop`.
 */
export function withEndTimer(
  config: ScheduleConfig,
  stop: () => void,
  onEnd: () => void,
): () => void {
  if (config.end_at === undefined) return stop;
  const stopEnd = armEndTimer(Date.parse(config.end_at), onEnd);
  return () => {
    stop();
    stopEnd();
  };
}
