import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import chalk from "chalk";
import ora from "ora";
import {
  TuttiRuntime,
  ScoreLoader,
  AnthropicProvider,
  OpenAIProvider,
  GeminiProvider,
  SecretsManager,
  InMemorySessionStore,
  logger as coreLogger,
} from "@tuttiai/core";
import type { ScoreConfig, SessionStore } from "@tuttiai/types";
import { ReactiveScore } from "../watch/score-watcher.js";
import { logger } from "../logger.js";

export interface RunOptions {
  /** Reload the score on file changes. */
  watch?: boolean;
}

export async function runCommand(
  scorePath?: string,
  options: RunOptions = {},
): Promise<void> {
  const file = resolve(scorePath ?? "./tutti.score.ts");

  if (!existsSync(file)) {
    logger.error({ file }, "Score file not found");
    console.error(chalk.dim('Run "tutti-ai init" to create a new project.'));
    process.exit(1);
  }

  let score;
  try {
    score = await ScoreLoader.load(file);
  } catch (err) {
    logger.error(
      { error: err instanceof Error ? err.message : String(err) },
      "Failed to load score",
    );
    process.exit(1);
  }

  // Validate that the provider has a valid API key
  const providerKeyMap: [unknown, string][] = [
    [AnthropicProvider, "ANTHROPIC_API_KEY"],
    [OpenAIProvider, "OPENAI_API_KEY"],
    [GeminiProvider, "GEMINI_API_KEY"],
  ];

  for (const [ProviderClass, envVar] of providerKeyMap) {
    if (score.provider instanceof (ProviderClass as new (...args: unknown[]) => unknown)) {
      const key = SecretsManager.optional(envVar);
      if (!key) {
        logger.error({ envVar }, "Missing API key");
        process.exit(1);
      }
    }
  }

  // Enable streaming on every agent in the score.
  const applyRunDefaults = (cfg: ScoreConfig): void => {
    for (const agent of Object.values(cfg.agents)) {
      agent.streaming = true;
    }
  };
  applyRunDefaults(score);

  const sharedSessions: SessionStore | undefined = options.watch
    ? new InMemorySessionStore()
    : undefined;

  const spinner = ora({ color: "cyan" });

  // Silence pino during the REPL. Any pino output fires via
  // pino-pretty's async worker-thread transport which writes to stdout
  // and interferes with readline.
  coreLogger.level = "silent";
  logger.level = "silent";

  let streaming = false;
  let runtime = buildRuntime(score, sharedSessions);

  attachListeners(runtime);

  // Wire per-runtime listeners.
  function attachListeners(r: TuttiRuntime): void {
    r.events.on("llm:request", () => {
      spinner.start("Thinking...");
    });

    r.events.on("token:stream", (e) => {
      if (!streaming) {
        spinner.stop();
        streaming = true;
      }
      process.stdout.write(e.text);
    });

    r.events.on("llm:response", () => {
      if (streaming) {
        process.stdout.write("\n");
      } else {
        spinner.stop();
      }
    });

    r.events.on("tool:start", (e) => {
      if (streaming) {
        process.stdout.write(chalk.dim("\n  [using: " + e.tool_name + "]"));
      } else {
        spinner.stop();
        console.log(chalk.dim("  [using: " + e.tool_name + "]"));
      }
    });

    r.events.on("tool:end", (e) => {
      if (streaming) {
        process.stdout.write(chalk.dim("  [done: " + e.tool_name + "]\n"));
      }
    });

    r.events.on("tool:error", (e) => {
      spinner.stop();
      console.error(chalk.red("  Tool error: " + e.tool_name));
    });

    r.events.on("budget:warning", () => {
      console.error(chalk.yellow("  Approaching token budget (80%)"));
    });

    r.events.on("budget:exceeded", () => {
      console.error(chalk.red("  Token budget exceeded — stopping"));
    });
  }

  // --- Watch mode ---
  let reactive: ReactiveScore | undefined;
  if (options.watch) {
    reactive = new ReactiveScore(score, file);
    reactive.on("file-change", () => {
      console.log(chalk.cyan("\n[tutti] Score changed, reloading..."));
    });
    reactive.on("reloaded", () => {
      console.log(chalk.green("[tutti] Score reloaded. Changes applied."));
    });
    reactive.on("reload-failed", (err) => {
      console.error(
        chalk.red("[tutti] Reload failed — using previous config: " +
          (err instanceof Error ? err.message : String(err))),
      );
    });
  }

  // REPL
  console.log(chalk.dim('Tutti REPL — type "exit" to quit\n'));
  if (options.watch) {
    console.log(chalk.dim("Watching " + file + " for changes…\n"));
  }

  let sessionId: string | undefined;

  // Keepalive: prevent the event loop from exiting while waiting for
  // user input between turns.
  const keepalive = setInterval(() => {}, 60_000);

  // Handle Ctrl+C cleanly
  process.on("SIGINT", () => {
    clearInterval(keepalive);
    if (streaming) process.stdout.write("\n");
    spinner.stop();
    console.log(chalk.dim("Goodbye!"));
    if (reactive) void reactive.close();
    process.exit(0);
  });

  try {
    while (true) {
      if (reactive?.pendingReload) {
        const nextScore = reactive.current;
        applyRunDefaults(nextScore);
        runtime = buildRuntime(nextScore, sharedSessions);
        attachListeners(runtime);
        reactive.consumePendingReload();
      }

      // Create a fresh readline interface for each prompt. Streaming
      // output (process.stdout.write) during the agent run corrupts
      // readline's internal cursor tracking and key handling — the
      // backspace key shows literal ^? and arrows show ^[[D on
      // subsequent question() calls from the same interface. A fresh
      // interface has clean state every turn.
      spinner.stop();
      const input = await askQuestion(chalk.cyan("> "));
      const trimmed = input.trim();

      if (!trimmed) continue;
      if (trimmed === "exit" || trimmed === "quit") break;

      streaming = false;

      try {
        const result = await runtime.run("assistant", trimmed, sessionId);
        sessionId = result.session_id;

        if (!streaming) {
          console.log("\n" + result.output + "\n");
        } else {
          console.log();
        }
      } catch (err) {
        if (streaming) process.stdout.write("\n");
        spinner.stop();
        console.error(
          chalk.red("  Error: " +
            (err instanceof Error ? err.message : String(err))),
        );
      }
    }
  } catch (err) {
    if (err instanceof Error && err.message !== "readline was closed") {
      console.error(chalk.red("REPL error: " + err.message));
    }
  }

  clearInterval(keepalive);
  console.log(chalk.dim("Goodbye!"));
  if (reactive) await reactive.close();
  process.exit(0);
}

/**
 * Prompt the user with a fresh readline interface. The interface is
 * created and closed per-call so that stdout writes during the agent
 * run (streaming tokens, spinner, tool notifications) cannot corrupt
 * readline's internal key-handling state between turns.
 */
async function askQuestion(prompt: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}

function buildRuntime(
  score: ScoreConfig,
  sessionStore: SessionStore | undefined,
): TuttiRuntime {
  return new TuttiRuntime(
    score,
    sessionStore ? { sessionStore } : {},
  );
}
