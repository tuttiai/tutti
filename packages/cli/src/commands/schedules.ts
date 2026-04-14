/**
 * `tutti-ai schedules <subcommand>` — schedule management commands.
 *
 * All subcommands connect to the schedule store via TUTTI_PG_URL.
 * Falls back to in-memory (ephemeral) when TUTTI_PG_URL is not set.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import chalk from "chalk";
import {
  ScoreLoader,
  SchedulerEngine,
  PostgresScheduleStore,
  MemoryScheduleStore,
  AgentRunner,
  EventBus,
  InMemorySessionStore,
  SecretsManager,
  createLogger,
} from "@tuttiai/core";
import type { ScheduleStore, ScheduleRecord } from "@tuttiai/core";

const logger = createLogger("tutti-cli");

function resolveStore(): ScheduleStore {
  const pgUrl = SecretsManager.optional("TUTTI_PG_URL");
  if (pgUrl) {
    return new PostgresScheduleStore({ connection_string: pgUrl });
  }
  logger.warn("TUTTI_PG_URL not set — using in-memory store (schedules are ephemeral)");
  return new MemoryScheduleStore();
}

async function closeStore(store: ScheduleStore): Promise<void> {
  if ("close" in store && typeof (store as { close: () => Promise<void> }).close === "function") {
    await (store as { close: () => Promise<void> }).close();
  }
}

function formatTrigger(r: ScheduleRecord): string {
  if (r.config.cron) return "cron: " + r.config.cron;
  if (r.config.every) return "every " + r.config.every;
  if (r.config.at) return "at " + r.config.at;
  return "?";
}

function pad(s: string, len: number): string {
  return s.length >= len ? s : s + " ".repeat(len - s.length);
}

// ── list ──────────────────────────────────────────────────────

export async function schedulesListCommand(): Promise<void> {
  const store = resolveStore();
  try {
    const records = await store.list();

    if (records.length === 0) {
      console.log(chalk.dim("No schedules found."));
      console.log(chalk.dim('Run "tutti-ai schedule" to start the scheduler daemon.'));
      return;
    }

    console.log("");
    console.log(
      chalk.dim(
        "  " + pad("ID", 20) + pad("AGENT", 16) +
        pad("TRIGGER", 22) + pad("ENABLED", 10) +
        pad("RUNS", 8) + "CREATED",
      ),
    );
    console.log(chalk.dim("  " + "─".repeat(90)));

    for (const r of records) {
      const enabled = r.enabled
        ? chalk.green("yes")
        : chalk.red("no") + " ";
      const maxLabel = r.config.max_runs
        ? r.run_count + "/" + r.config.max_runs
        : String(r.run_count);

      console.log(
        "  " +
        chalk.bold(pad(r.id, 20)) +
        pad(r.agent_id, 16) +
        pad(formatTrigger(r), 22) +
        pad(enabled, 10) +
        pad(maxLabel, 8) +
        chalk.dim(r.created_at.toISOString().slice(0, 10)),
      );
    }
    console.log("");
  } finally {
    await closeStore(store);
  }
}

// ── enable ────────────────────────────────────────────────────

export async function schedulesEnableCommand(id: string): Promise<void> {
  const store = resolveStore();
  try {
    const record = await store.get(id);
    if (!record) {
      console.error(chalk.red('Schedule "' + id + '" not found.'));
      process.exit(1);
    }
    await store.setEnabled(id, true);
    console.log(chalk.green('Schedule "' + id + '" enabled.'));
  } finally {
    await closeStore(store);
  }
}

// ── disable ───────────────────────────────────────────────────

export async function schedulesDisableCommand(id: string): Promise<void> {
  const store = resolveStore();
  try {
    const record = await store.get(id);
    if (!record) {
      console.error(chalk.red('Schedule "' + id + '" not found.'));
      process.exit(1);
    }
    await store.setEnabled(id, false);
    console.log(chalk.yellow('Schedule "' + id + '" disabled.'));
  } finally {
    await closeStore(store);
  }
}

// ── trigger ───────────────────────────────────────────────────

export async function schedulesTriggerCommand(
  id: string,
  scorePath?: string,
): Promise<void> {
  const file = resolve(scorePath ?? "./tutti.score.ts");
  if (!existsSync(file)) {
    console.error(chalk.red("Score file not found: " + file));
    process.exit(1);
  }

  const score = await ScoreLoader.load(file);
  const events = new EventBus();
  const sessions = new InMemorySessionStore();
  const runner = new AgentRunner(score.provider, events, sessions);
  const store = resolveStore();

  try {
    const record = await store.get(id);
    if (!record) {
      console.error(chalk.red('Schedule "' + id + '" not found.'));
      process.exit(1);
    }

    const agent = score.agents[record.agent_id];
    if (!agent) {
      console.error(chalk.red('Agent "' + record.agent_id + '" not found in score.'));
      process.exit(1);
    }

    const resolvedAgent = agent.model
      ? agent
      : { ...agent, model: score.default_model ?? "claude-sonnet-4-20250514" };

    const engine = new SchedulerEngine(store, runner, events);
    await engine.schedule(id, resolvedAgent, record.config);
    engine.start();

    console.log(chalk.cyan('Triggering "' + id + '" (' + record.agent_id + ")..."));

    const run = await engine.trigger(id);

    engine.stop();

    if (run.error) {
      console.log(chalk.red("  Error: " + run.error));
      process.exit(1);
    }

    const duration = run.completed_at && run.triggered_at
      ? run.completed_at.getTime() - run.triggered_at.getTime()
      : 0;

    console.log(chalk.green("  Completed in " + duration + "ms"));
    if (run.result) {
      const preview = run.result.length > 200
        ? run.result.slice(0, 200) + "..."
        : run.result;
      console.log(chalk.dim("  Output: " + preview));
    }
  } finally {
    await closeStore(store);
  }
}

// ── runs ──────────────────────────────────────────────────────

export async function schedulesRunsCommand(id: string): Promise<void> {
  const store = resolveStore();
  try {
    const record = await store.get(id);
    if (!record) {
      console.error(chalk.red('Schedule "' + id + '" not found.'));
      process.exit(1);
    }

    // MemoryScheduleStore exposes getRuns(); Postgres tracks only run_count.
    if ("getRuns" in store && typeof (store as { getRuns: (id: string) => unknown[] }).getRuns === "function") {
      const runs = (store as { getRuns: (id: string) => Array<{
        triggered_at: Date;
        completed_at?: Date;
        result?: string;
        error?: string;
      }> }).getRuns(id);

      if (runs.length === 0) {
        console.log(chalk.dim("No runs recorded for this schedule."));
        return;
      }

      const recent = runs.slice(-20);
      console.log("");
      console.log(chalk.dim("  Showing last " + recent.length + " of " + runs.length + " runs:"));
      console.log("");

      for (const run of recent) {
        const duration = run.completed_at && run.triggered_at
          ? (run.completed_at.getTime() - run.triggered_at.getTime()) + "ms"
          : "?";
        const status = run.error
          ? chalk.red("error")
          : chalk.green("ok");
        const preview = run.error
          ? run.error.slice(0, 80)
          : (run.result ?? "").slice(0, 80);
        console.log(
          "  " + chalk.dim(run.triggered_at.toISOString()) + "  " +
          status + "  " + chalk.dim(duration) + "  " + preview,
        );
      }
      console.log("");
    } else {
      // Postgres store — only has run_count, not full history
      console.log(chalk.dim('Schedule "' + id + '" has completed ' + record.run_count + " runs."));
      console.log(chalk.dim("Full run history requires the MemoryScheduleStore or a future tutti_schedule_runs table."));
    }
  } finally {
    await closeStore(store);
  }
}
