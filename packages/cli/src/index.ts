import { config } from "dotenv";
config();

import { createLogger } from "@tuttiai/core";
const logger = createLogger("tutti-cli");

process.on("unhandledRejection", (reason) => {
  logger.error({ error: reason instanceof Error ? reason.message : String(reason) }, "Unhandled rejection");
  process.exit(1);
});

process.on("uncaughtException", (err) => {
  logger.error({ error: err.message }, "Fatal error");
  process.exit(1);
});

import { Command } from "commander";
import { initCommand, templatesCommand } from "./commands/init.js";
import { runCommand } from "./commands/run.js";
import { resumeCommand, type ResumeOptions } from "./commands/resume.js";
import { addCommand } from "./commands/add.js";
import { checkCommand } from "./commands/check.js";
import { studioCommand } from "./commands/studio.js";
import { searchCommand, voicesCommand } from "./commands/search.js";
import { publishCommand } from "./commands/publish.js";
import { evalCommand } from "./commands/eval.js";
import { evalRecordCommand } from "./commands/eval-record.js";
import { evalListCommand } from "./commands/eval-list.js";
import { serveCommand, type ServeOptions } from "./commands/serve.js";
import { scheduleCommand } from "./commands/schedule.js";
import { updateCommand } from "./commands/update.js";
import { outdatedCommand } from "./commands/outdated.js";
import { infoCommand } from "./commands/info.js";
import { upgradeCommand } from "./commands/upgrade.js";
import { replayCommand } from "./commands/replay.js";
import {
  schedulesListCommand,
  schedulesEnableCommand,
  schedulesDisableCommand,
  schedulesTriggerCommand,
  schedulesRunsCommand,
} from "./commands/schedules.js";
import {
  tracesListCommand,
  tracesShowCommand,
  tracesTailCommand,
  type TracesOptions,
} from "./commands/traces.js";
import {
  memoryAddCommand,
  memoryClearCommand,
  memoryDeleteCommand,
  memoryExportCommand,
  memoryListCommand,
  memorySearchCommand,
} from "./commands/memory.js";
import {
  interruptsApproveCommand,
  interruptsDenyCommand,
  interruptsListCommand,
  interruptsTUICommand,
  type InterruptsOptions,
} from "./commands/interrupts.js";

const program = new Command();

program
  .name("tutti-ai")
  .description("Tutti — multi-agent orchestration. All agents. All together.")
  .version("0.13.0");

program
  .command("init [project-name]")
  .description("Create a new Tutti project")
  .option("-t, --template <id>", "Project template to use")
  .action(async (projectName: string | undefined, opts: { template?: string }) => {
    await initCommand(projectName, opts.template);
  });

program
  .command("templates")
  .description("List all available project templates")
  .action(() => {
    templatesCommand();
  });

program
  .command("run [score]")
  .description("Run a Tutti score interactively")
  .option("-w, --watch", "Reload the score on file changes")
  .action(async (score: string | undefined, opts: { watch?: boolean }) => {
    await runCommand(score, { watch: opts.watch });
  });

program
  .command("serve [score]")
  .description("Start the Tutti HTTP server")
  .option("-p, --port <number>", "Port to listen on (default: 3847)")
  .option("-H, --host <address>", "Host to bind to (default: 0.0.0.0)")
  .option("-k, --api-key <key>", "API key for bearer auth (or set TUTTI_API_KEY)")
  .option("-a, --agent <name>", "Agent to expose (default: score entry or first agent)")
  .option("-w, --watch", "Reload the score on file changes")
  .action(async (score: string | undefined, opts: ServeOptions) => {
    await serveCommand(score, opts);
  });

program
  .command("resume <session-id>")
  .description("Resume a crashed or interrupted run from its last checkpoint")
  .option(
    "--store <backend>",
    "Durable store the checkpoint was written to (redis | postgres)",
    "redis",
  )
  .option("-s, --score <path>", "Path to score file (default: ./tutti.score.ts)")
  .option("-a, --agent <name>", "Agent key to resume (default: score.entry or the first agent)")
  .option("-y, --yes", "Skip the confirmation prompt")
  .action(
    async (
      sessionId: string,
      opts: { store?: string; score?: string; agent?: string; yes?: boolean },
    ) => {
      if (opts.store !== "redis" && opts.store !== "postgres") {
        console.error("--store must be 'redis' or 'postgres'");
        process.exit(1);
      }
      const resolved: ResumeOptions = {
        store: opts.store,
        ...(opts.score !== undefined ? { score: opts.score } : {}),
        ...(opts.agent !== undefined ? { agent: opts.agent } : {}),
        ...(opts.yes !== undefined ? { yes: opts.yes } : {}),
      };
      await resumeCommand(sessionId, resolved);
    },
  );

program
  .command("add <voice>")
  .description("Add a voice to your project")
  .action((voice: string) => {
    addCommand(voice);
  });

program
  .command("check [score]")
  .description("Validate a score file without running it")
  .action(async (score?: string) => {
    await checkCommand(score);
  });

program
  .command("doctor [score]")
  .description("Alias for check — validate a score file")
  .action(async (score?: string) => {
    await checkCommand(score);
  });

program
  .command("studio [score]")
  .description("Launch Tutti Studio — local web UI for inspecting agent runs")
  .action(async (score?: string) => {
    await studioCommand(score);
  });

program
  .command("search <query>")
  .description("Search the voice registry for voices matching a query")
  .action(async (query: string) => {
    await searchCommand(query);
  });

program
  .command("voices")
  .description("List all available official voices and install status")
  .action(async () => {
    await voicesCommand();
  });

program
  .command("publish")
  .description("Publish the current voice to npm and the voice registry")
  .option("--dry-run", "Run all checks without publishing")
  .action(async (opts: { dryRun?: boolean }) => {
    await publishCommand(opts);
  });

const evalCmd = program
  .command("eval [suite-file]")
  .description("Run an evaluation suite against a score")
  .option("--ci", "Exit with code 1 if any case fails")
  .option("-s, --score <path>", "Path to score file (default: ./tutti.score.ts)")
  .action(async (
    suitePath: string | undefined,
    opts: { ci?: boolean; score?: string },
  ) => {
    if (!suitePath) {
      console.error(
        "Usage: tutti-ai eval <suite-file>\n" +
          "       tutti-ai eval record <session-id>\n" +
          "       tutti-ai eval list",
      );
      process.exit(1);
    }
    await evalCommand(suitePath, opts);
  });

evalCmd
  .command("record <session-id>")
  .description("Promote a past session run to a golden eval case")
  .action(async (sessionId: string) => {
    await evalRecordCommand(sessionId);
  });

evalCmd
  .command("list")
  .description("Show every golden case + latest-run status")
  .action(async () => {
    await evalListCommand();
  });

program
  .command("update")
  .description("Update @tuttiai packages to their latest versions")
  .action(() => {
    updateCommand();
  });

program
  .command("outdated")
  .description("Check installed @tuttiai packages for newer versions")
  .action(() => {
    outdatedCommand();
  });

program
  .command("info [score]")
  .description("Show project info — agents, voices, models, and package versions")
  .action(async (score?: string) => {
    await infoCommand(score);
  });

program
  .command("upgrade [voice]")
  .description("Upgrade a specific voice or all @tuttiai packages to latest")
  .action((voice?: string) => {
    upgradeCommand(voice);
  });

program
  .command("replay <session-id>")
  .description("Time-travel debugger — navigate and replay a session from PostgreSQL")
  .option("-s, --score <path>", "Path to score file for replay-from (default: ./tutti.score.ts)")
  .action(async (sessionId: string, opts: { score?: string }) => {
    await replayCommand(sessionId, { score: opts.score });
  });

program
  .command("schedule [score]")
  .description("Start the scheduler daemon — runs agents on their configured schedules")
  .action(async (score?: string) => {
    await scheduleCommand(score);
  });

const schedulesCmd = program
  .command("schedules")
  .description("Manage scheduled agents");

schedulesCmd
  .command("list")
  .description("Show all registered schedules")
  .action(async () => {
    await schedulesListCommand();
  });

schedulesCmd
  .command("enable <id>")
  .description("Enable a disabled schedule")
  .action(async (id: string) => {
    await schedulesEnableCommand(id);
  });

schedulesCmd
  .command("disable <id>")
  .description("Disable a schedule without deleting it")
  .action(async (id: string) => {
    await schedulesDisableCommand(id);
  });

schedulesCmd
  .command("trigger <id>")
  .description("Manually trigger a scheduled run immediately")
  .option("-s, --score <path>", "Path to score file (default: ./tutti.score.ts)")
  .action(async (id: string, opts: { score?: string }) => {
    await schedulesTriggerCommand(id, opts.score);
  });

schedulesCmd
  .command("runs <id>")
  .description("Show run history for a schedule (last 20 runs)")
  .action(async (id: string) => {
    await schedulesRunsCommand(id);
  });

const tracesCmd = program
  .command("traces")
  .description("Inspect spans emitted by a running tutti-ai serve process");

tracesCmd
  .command("list")
  .description("Show the last 20 traces (most recent first)")
  .option("-u, --url <url>", "Server URL (default: http://127.0.0.1:3847)")
  .option("-k, --api-key <key>", "Bearer token (default: TUTTI_API_KEY env)")
  .action(async (opts: { url?: string; apiKey?: string }) => {
    const resolved: TracesOptions = {
      ...(opts.url !== undefined ? { url: opts.url } : {}),
      ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
    };
    await tracesListCommand(resolved);
  });

tracesCmd
  .command("show <trace-id>")
  .description("Render every span in a trace as an indented tree")
  .option("-u, --url <url>", "Server URL (default: http://127.0.0.1:3847)")
  .option("-k, --api-key <key>", "Bearer token (default: TUTTI_API_KEY env)")
  .action(async (traceId: string, opts: { url?: string; apiKey?: string }) => {
    const resolved: TracesOptions = {
      ...(opts.url !== undefined ? { url: opts.url } : {}),
      ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
    };
    await tracesShowCommand(traceId, resolved);
  });

tracesCmd
  .command("tail")
  .description("Live-tail spans as they are emitted (Ctrl+C to exit)")
  .option("-u, --url <url>", "Server URL (default: http://127.0.0.1:3847)")
  .option("-k, --api-key <key>", "Bearer token (default: TUTTI_API_KEY env)")
  .action(async (opts: { url?: string; apiKey?: string }) => {
    const resolved: TracesOptions = {
      ...(opts.url !== undefined ? { url: opts.url } : {}),
      ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
    };
    await tracesTailCommand(resolved);
  });

const memoryCmd = program
  .command("memory")
  .description("Manage per-user memories (uses TUTTI_PG_URL like the runtime)");

memoryCmd
  .command("list")
  .description("Show every memory for a user, sorted by importance + recency")
  .requiredOption("--user <user-id>", "End-user identifier")
  .action(async (opts: { user: string }) => {
    await memoryListCommand({ user: opts.user });
  });

memoryCmd
  .command("search <query>")
  .description("Search a user's memories by relevance")
  .requiredOption("--user <user-id>", "End-user identifier")
  .action(async (query: string, opts: { user: string }) => {
    await memorySearchCommand(query, { user: opts.user });
  });

memoryCmd
  .command("add <content>")
  .description("Manually store a memory for a user")
  .requiredOption("--user <user-id>", "End-user identifier")
  .option("--importance <n>", "Importance: 1 (low), 2 (normal), 3 (high)", "2")
  .action(async (content: string, opts: { user: string; importance?: string }) => {
    await memoryAddCommand(content, {
      user: opts.user,
      ...(opts.importance !== undefined ? { importance: opts.importance } : {}),
    });
  });

memoryCmd
  .command("delete <memory-id>")
  .description("Delete a specific memory by id")
  .requiredOption("--user <user-id>", "End-user identifier")
  .action(async (memoryId: string, opts: { user: string }) => {
    await memoryDeleteCommand(memoryId, { user: opts.user });
  });

memoryCmd
  .command("clear")
  .description("Delete every memory for a user (prompts for confirmation)")
  .requiredOption("--user <user-id>", "End-user identifier")
  .action(async (opts: { user: string }) => {
    await memoryClearCommand({ user: opts.user });
  });

memoryCmd
  .command("export")
  .description("Export every memory for a user as JSON or CSV")
  .requiredOption("--user <user-id>", "End-user identifier")
  .option("--format <fmt>", "Output format: json | csv", "json")
  .option("-o, --out <path>", "Write to file instead of stdout")
  .action(async (opts: { user: string; format?: string; out?: string }) => {
    await memoryExportCommand({
      user: opts.user,
      ...(opts.format !== undefined ? { format: opts.format } : {}),
      ...(opts.out !== undefined ? { out: opts.out } : {}),
    });
  });

// Shared builder for the server-URL + api-key flags used by every
// interrupt subcommand. Keeps the option wiring DRY across commander
// definitions.
function toInterruptsOptions(raw: { url?: string; apiKey?: string }): InterruptsOptions {
  return {
    ...(raw.url !== undefined ? { url: raw.url } : {}),
    ...(raw.apiKey !== undefined ? { apiKey: raw.apiKey } : {}),
  };
}

const interruptsCmd = program
  .command("interrupts")
  .description("Review and resolve approval-gated tool calls");

// `tutti-ai interrupts` with no subcommand opens the interactive TUI.
interruptsCmd
  .option("-u, --url <url>", "Server URL (default: http://127.0.0.1:3847)")
  .option("-k, --api-key <key>", "Bearer token (default: TUTTI_API_KEY env)")
  .action(async (opts: { url?: string; apiKey?: string }) => {
    await interruptsTUICommand(toInterruptsOptions(opts));
  });

interruptsCmd
  .command("list")
  .description("Print pending interrupts as a table and exit (script-friendly)")
  .option("-u, --url <url>", "Server URL (default: http://127.0.0.1:3847)")
  .option("-k, --api-key <key>", "Bearer token (default: TUTTI_API_KEY env)")
  .action(async (opts: { url?: string; apiKey?: string }) => {
    await interruptsListCommand(toInterruptsOptions(opts));
  });

interruptsCmd
  .command("approve <interrupt-id>")
  .description("Approve an interrupt directly")
  .option("-u, --url <url>", "Server URL (default: http://127.0.0.1:3847)")
  .option("-k, --api-key <key>", "Bearer token (default: TUTTI_API_KEY env)")
  .option("--by <name>", "Reviewer identifier (resolved_by field)")
  .action(async (id: string, opts: { url?: string; apiKey?: string; by?: string }) => {
    await interruptsApproveCommand(id, {
      ...toInterruptsOptions(opts),
      ...(opts.by !== undefined ? { resolvedBy: opts.by } : {}),
    });
  });

interruptsCmd
  .command("deny <interrupt-id>")
  .description("Deny an interrupt directly")
  .option("-u, --url <url>", "Server URL (default: http://127.0.0.1:3847)")
  .option("-k, --api-key <key>", "Bearer token (default: TUTTI_API_KEY env)")
  .option("--reason <text>", "Free-text denial reason")
  .option("--by <name>", "Reviewer identifier (resolved_by field)")
  .action(async (
    id: string,
    opts: { url?: string; apiKey?: string; reason?: string; by?: string },
  ) => {
    await interruptsDenyCommand(id, {
      ...toInterruptsOptions(opts),
      ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
      ...(opts.by !== undefined ? { resolvedBy: opts.by } : {}),
    });
  });

// Alias: `tutti-ai approve` → same as `tutti-ai interrupts`.
program
  .command("approve")
  .description("Alias for `tutti-ai interrupts` — interactive approval TUI")
  .option("-u, --url <url>", "Server URL (default: http://127.0.0.1:3847)")
  .option("-k, --api-key <key>", "Bearer token (default: TUTTI_API_KEY env)")
  .action(async (opts: { url?: string; apiKey?: string }) => {
    await interruptsTUICommand(toInterruptsOptions(opts));
  });

program.parse();
