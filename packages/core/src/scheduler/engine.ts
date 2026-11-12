/**
 * Scheduler engine — registers schedules for agents and triggers
 * them on cron expressions, fixed intervals, or one-shot datetimes.
 */

import cron from "node-cron";
import type { AgentConfig } from "@tuttiai/types";
import type { AgentRunner } from "../agent-runner.js";
import type { EventBus } from "../event-bus.js";
import { logger } from "../logger.js";
import { SecretsManager } from "../secrets.js";
import { assertDeliveryVoiceInstalled } from "./delivery.js";
import { deliverScheduleResult, deliveryTargetSummary } from "./dispatch.js";
import { endAtState, maxRunsReason, pastEndAtError, stopReason, withEndTimer } from "./end-at.js";
import type { StopReason } from "./end-at.js";
import type { ScheduleStore } from "./store.js";
import type { ScheduleConfig, ScheduledRun, ScheduleRecord } from "./types.js";

// ── Interval parser ──────────────────────────────────────────

// eslint-disable-next-line security/detect-unsafe-regex -- simple regex with no nested quantifiers
const INTERVAL_RE = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/;
const MULTIPLIERS = new Map<string, number>([
  ["ms", 1],
  ["s", 1_000],
  ["m", 60_000],
  ["h", 3_600_000],
  ["d", 86_400_000],
]);

/**
 * Parse a human-friendly interval string into milliseconds.
 *
 * @param every - E.g. `"1h"`, `"30m"`, `"5s"`, `"2d"`, `"500ms"`.
 * @returns Milliseconds.
 * @throws When the format is not recognised.
 */
export function parseInterval(every: string): number {
  const match = every.match(INTERVAL_RE);
  if (!match) {
    throw new Error(
      `Invalid interval "${every}". Expected format: <number><unit> ` +
        `where unit is ms, s, m, h, or d. Examples: "30m", "1h", "500ms".`,
    );
  }
  const value = parseFloat(match[1] ?? "0");
  const unit = match[2] ?? "ms";
  return value * (MULTIPLIERS.get(unit) ?? 0);
}

/**
 * Validate a 5-field cron expression.
 *
 * Delegates to `node-cron`'s built-in validator.
 */
export function validateCron(expression: string): boolean {
  return cron.validate(expression);
}

/**
 * Check that exactly one trigger is set and that it parses.
 *
 * @throws When no trigger is set or the set one is malformed.
 */
function assertValidTrigger(id: string, config: ScheduleConfig): void {
  if (!config.cron && !config.every && !config.at) {
    throw new Error(
      `Schedule "${id}": exactly one of cron, every, or at must be set.`,
    );
  }
  if (config.cron && !validateCron(config.cron)) {
    throw new Error(`Schedule "${id}": invalid cron expression "${config.cron}".`);
  }
  if (config.every) {
    parseInterval(config.every); // throws on bad format
  }
  if (config.at) {
    const d = new Date(config.at);
    if (isNaN(d.getTime())) {
      throw new Error(`Schedule "${id}": invalid ISO datetime "${config.at}".`);
    }
  }
}

// ── Engine ───────────────────────────────────────────────────

interface ActiveSchedule {
  record: ScheduleRecord;
  agent: AgentConfig;
  stop: () => void;
}

/**
 * Scheduler engine — manages the lifecycle of all registered schedules.
 *
 * Call {@link schedule} to register an agent, then {@link start} to
 * activate all timers. Call {@link stop} to tear down cleanly.
 *
 * @example
 * ```typescript
 * const engine = new SchedulerEngine(store, runner, events);
 * engine.schedule("nightly-report", reportAgent, {
 *   cron: "0 9 * * *",
 *   input: "Generate the daily status report",
 *   max_runs: 30,
 * });
 * engine.start();
 * ```
 */
export class SchedulerEngine {
  private readonly store: ScheduleStore;
  private readonly runner: AgentRunner;
  private readonly events: EventBus;
  private readonly active = new Map<string, ActiveSchedule>();
  private running = false;

  constructor(store: ScheduleStore, runner: AgentRunner, events: EventBus) {
    this.store = store;
    this.runner = runner;
    this.events = events;
  }

  /**
   * Register a new schedule. Does NOT start the timer — call {@link start}
   * (or call this after `start()` for hot-registration).
   */
  async schedule(
    id: string,
    agent: AgentConfig,
    config: ScheduleConfig,
  ): Promise<void> {
    assertValidTrigger(id, config);
    const ended = await this.endAtPassed(id, config);
    if (config.deliver) {
      await assertDeliveryVoiceInstalled(config.deliver);
    }

    const record: ScheduleRecord = {
      id,
      agent_id: agent.name,
      config,
      enabled: !ended,
      created_at: new Date(),
      run_count: 0,
    };

    await this.store.save(record);

    // Always register in active map so trigger() works before start().
    // If already running, start the timer immediately.
    this.active.set(id, { record, agent, stop: () => undefined });

    if (this.running && record.enabled) {
      this.activateTimer(id, record, agent);
    }

    logger.info({ schedule: id, agent: agent.name }, "Schedule registered");
  }

  /**
   * Validate `config.end_at` and report whether it has already passed.
   * A passed end_at is an error for a new id, but marks a schedule the
   * store already holds (reloaded after a restart) as finished.
   */
  private async endAtPassed(id: string, config: ScheduleConfig): Promise<boolean> {
    const now = Date.now();
    if (endAtState(id, config, now) === "open") return false;
    if ((await this.store.get(id)) === null) throw pastEndAtError(id, config, now);
    logger.warn({ schedule: id, end_at: config.end_at }, "Schedule registered disabled: end_at already passed");
    return true;
  }

  /** Remove a schedule and stop its timer. */
  async unschedule(id: string): Promise<void> {
    const entry = this.active.get(id);
    if (entry) {
      entry.stop();
      this.active.delete(id);
    }
    await this.store.delete(id);
    logger.info({ schedule: id }, "Schedule removed");
  }

  /** Activate timers for all registered schedules. */
  start(): void {
    this.running = true;
    for (const [id, entry] of this.active) {
      if (!entry.record.enabled) continue;
      this.activateTimer(id, entry.record, entry.agent);
    }
    logger.info({ count: this.active.size }, "Scheduler started");
  }

  /** Stop all active timers. */
  stop(): void {
    for (const [id, entry] of this.active) {
      entry.stop();
      logger.debug({ schedule: id }, "Schedule timer stopped");
    }
    this.active.clear();
    this.running = false;
    logger.info("Scheduler stopped");
  }

  /**
   * Trigger a schedule immediately (bypasses timer).
   *
   * Respects `max_runs` — the schedule is disabled after the limit is
   * reached, just like a timer-triggered run.
   * Respects `end_at` the same way: a trigger after end_at does not run.
   *
   * Useful for testing and manual "run now" actions.
   */
  async trigger(id: string): Promise<ScheduledRun> {
    const entry = this.active.get(id);
    if (!entry) {
      throw new Error(`Schedule "${id}" not found or not active.`);
    }
    const run = await this.onTick(id);
    if (!run) {
      throw new Error(`Schedule "${id}" did not execute (disabled or max_runs reached, or end_at passed).`);
    }
    return run;
  }

  // ── Private ──────────────────────────────────────────────────

  private activateTimer(
    id: string,
    record: ScheduleRecord,
    agent: AgentConfig,
  ): void {
    const config = record.config;

    let stopFn: () => void;

    if (config.cron) {
      const task = cron.schedule(config.cron, () => {
        void this.onTick(id);
      });
      stopFn = () => task.stop();
    } else if (config.every) {
      const ms = parseInterval(config.every);
      const handle = setInterval(() => {
        void this.onTick(id);
      }, ms);
      stopFn = () => clearInterval(handle);
    } else if (config.at) {
      const delay = new Date(config.at).getTime() - Date.now();
      if (delay <= 0) {
        // Already in the past — fire once immediately
        void this.onTick(id);
        stopFn = () => undefined;
      } else {
        const handle = setTimeout(() => {
          void this.onTick(id);
        }, delay);
        stopFn = () => clearTimeout(handle);
      }
    } else {
      stopFn = () => undefined;
    }

    const stop = withEndTimer(config, stopFn, () => {
      void this.onTick(id);
    });
    this.active.set(id, { record, agent, stop });
  }

  private async onTick(id: string): Promise<ScheduledRun | undefined> {
    const entry = this.active.get(id);
    if (!entry) return undefined;

    // Re-check enabled, end_at and max_runs from store
    const fresh = await this.store.get(id);
    if (!fresh || !fresh.enabled) return undefined;

    const reason = stopReason(fresh, Date.now());
    if (reason) {
      await this.finish(id, entry, reason);
      return undefined;
    }

    const run = await this.executeRun(entry.record, entry.agent);

    // Check max_runs again after this run
    const updated = await this.store.get(id);
    const after = updated ? maxRunsReason(updated) : undefined;
    if (after) await this.finish(id, entry, after);

    return run;
  }

  /** Disable a schedule in the store, stop its timers and log why. */
  private async finish(id: string, entry: ActiveSchedule, reason: StopReason): Promise<void> {
    await this.store.setEnabled(id, false);
    entry.stop();
    logger.info({ schedule: id, ...reason.fields }, reason.message);
  }

  private async executeRun(
    record: ScheduleRecord,
    agent: AgentConfig,
  ): Promise<ScheduledRun> {
    const run: ScheduledRun = {
      schedule_id: record.id,
      agent_id: record.agent_id,
      triggered_at: new Date(),
    };

    this.events.emit({
      type: "schedule:triggered",
      schedule_id: record.id,
      agent_name: record.agent_id,
    } as never);

    try {
      const result = await this.runner.run(agent, record.config.input);

      run.completed_at = new Date();
      run.result = result.output;

      await this.store.addRun(record.id, run);

      this.events.emit({
        type: "schedule:completed",
        schedule_id: record.id,
        agent_name: record.agent_id,
        duration_ms: run.completed_at.getTime() - run.triggered_at.getTime(),
      } as never);

      logger.info(
        { schedule: record.id, agent: record.agent_id },
        "Scheduled run completed",
      );

      // Delivery is a side effect of a successful run — a dispatch
      // failure must never propagate up and tank the schedule timer.
      if (record.config.deliver) {
        await this.dispatchDelivery(record, agent, result.output);
      }
    } catch (err) {
      run.completed_at = new Date();
      run.error = err instanceof Error ? err.message : String(err);

      await this.store.addRun(record.id, run);

      this.events.emit({
        type: "schedule:error",
        schedule_id: record.id,
        agent_name: record.agent_id,
        error: err instanceof Error ? err : new Error(String(err)),
      } as never);

      logger.error(
        { schedule: record.id, agent: record.agent_id, error: run.error },
        "Scheduled run failed",
      );
    }

    return run;
  }

  private async dispatchDelivery(
    record: ScheduleRecord,
    agent: AgentConfig,
    content: string,
  ): Promise<void> {
    const target = record.config.deliver;
    if (!target) return;
    try {
      await deliverScheduleResult({
        target,
        content,
        format: record.config.deliver_format ?? "text",
        agentName: agent.name,
      });
      this.events.emit({
        type: "schedule:delivered",
        agent_name: record.agent_id,
        platform: target.platform,
        target: deliveryTargetSummary(target),
        chars: content.length,
      } as never);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.events.emit({
        type: "schedule:delivery_failed",
        agent_name: record.agent_id,
        platform: target.platform,
        target: deliveryTargetSummary(target),
        error: SecretsManager.redact(msg),
      } as never);
      logger.warn(
        { schedule: record.id, platform: target.platform, error: msg },
        "Scheduled delivery failed",
      );
    }
  }
}
