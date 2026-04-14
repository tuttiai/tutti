/**
 * `tutti-ai schedule [score]` — start the scheduler daemon.
 *
 * Reads the score file, registers all agents that have a `schedule`
 * config, then runs until killed. Uses PostgreSQL via `TUTTI_PG_URL`
 * for schedule persistence, falling back to in-memory for local dev.
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
import type { ScheduleStore } from "@tuttiai/core";

const logger = createLogger("tutti-cli");

function resolveStore(): ScheduleStore {
  const pgUrl = SecretsManager.optional("TUTTI_PG_URL");
  if (pgUrl) {
    return new PostgresScheduleStore({ connection_string: pgUrl });
  }
  logger.warn("TUTTI_PG_URL not set — using in-memory store (not durable across restarts)");
  return new MemoryScheduleStore();
}

export async function scheduleCommand(scorePath?: string): Promise<void> {
  const file = resolve(scorePath ?? "./tutti.score.ts");

  if (!existsSync(file)) {
    console.error(chalk.red("Score file not found: " + file));
    console.error(chalk.dim('Run "tutti-ai init" to create a new project.'));
    process.exit(1);
  }

  const score = await ScoreLoader.load(file);
  const events = new EventBus();
  const sessions = new InMemorySessionStore();
  const runner = new AgentRunner(
    score.provider,
    events,
    sessions,
  );

  const store = resolveStore();
  const engine = new SchedulerEngine(store, runner, events);

  // Register agents with schedule config
  let registered = 0;
  for (const [agentId, agent] of Object.entries(score.agents)) {
    if (!agent.schedule) continue;
    const resolvedAgent = agent.model
      ? agent
      : { ...agent, model: score.default_model ?? "claude-sonnet-4-20250514" };
    await engine.schedule(agentId, resolvedAgent, agent.schedule);
    registered++;
  }

  if (registered === 0) {
    console.log(chalk.yellow("No agents have a schedule config. Nothing to run."));
    console.log(chalk.dim("Add schedule: { cron: '...', input: '...' } to an agent in your score."));
    process.exit(0);
  }

  // Event logging
  events.onAny((e) => {
    if (e.type === "schedule:triggered") {
      const ev = e as { schedule_id: string; agent_name: string };
      console.log(
        chalk.dim(new Date().toISOString()) + " " +
        chalk.cyan("triggered") + " " +
        chalk.bold(ev.schedule_id) + " → " + ev.agent_name,
      );
    }
    if (e.type === "schedule:completed") {
      const ev = e as { schedule_id: string; agent_name: string; duration_ms: number };
      console.log(
        chalk.dim(new Date().toISOString()) + " " +
        chalk.green("completed") + " " +
        chalk.bold(ev.schedule_id) + " " +
        chalk.dim("(" + ev.duration_ms + "ms)"),
      );
    }
    if (e.type === "schedule:error") {
      const ev = e as { schedule_id: string; agent_name: string; error: Error };
      console.log(
        chalk.dim(new Date().toISOString()) + " " +
        chalk.red("error") + " " +
        chalk.bold(ev.schedule_id) + " — " + ev.error.message,
      );
    }
  });

  engine.start();

  // Banner
  console.log("");
  console.log(chalk.cyan.bold("  Tutti Scheduler"));
  console.log(chalk.dim("  Score: " + (score.name ?? file)));
  console.log(chalk.dim("  Schedules: " + registered));
  console.log(chalk.dim("  Store: " + (SecretsManager.optional("TUTTI_PG_URL") ? "postgres" : "memory")));
  console.log("");
  console.log(chalk.dim("  Press Ctrl+C to stop."));
  console.log("");

  // Graceful shutdown
  const shutdown = () => {
    console.log(chalk.dim("\n  Shutting down scheduler..."));
    engine.stop();
    if ("close" in store && typeof (store as { close: () => Promise<void> }).close === "function") {
      void (store as { close: () => Promise<void> }).close();
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Keep process alive
  await new Promise(() => undefined);
}
