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

  // Enable streaming on every agent in the score. Factored out so we can
  // reapply it after a hot-reload in watch mode.
  const applyRunDefaults = (cfg: ScoreConfig): void => {
    for (const agent of Object.values(cfg.agents)) {
      agent.streaming = true;
    }
  };
  applyRunDefaults(score);

  // Build a single session store up front in watch mode so the
  // conversation history survives runtime swaps. Non-watch runs can let
  // TuttiRuntime provision its own store from score.memory as usual.
  const sharedSessions: SessionStore | undefined = options.watch
    ? new InMemorySessionStore()
    : undefined;

  const spinner = ora({ color: "cyan" });

  // REPL-level state. `streaming` resets per turn; `runtime` may be
  // swapped by the hot-reload path below.
  let streaming = false;
  let runtime = buildRuntime(score, sharedSessions);

  attachListeners(runtime);

  // REPL readline — created early so the HITL handler below can use it.
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // Wire per-runtime listeners. Separated from the REPL so a hot-reload
  // can swap the runtime and re-wire without touching the outer loop.
  function attachListeners(r: TuttiRuntime): void {
    r.events.on("agent:start", (e) => {
      logger.info({ agent: e.agent_name }, "Running agent");
    });

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
      logger.error({ tool: e.tool_name }, "Tool error");
    });

    r.events.on("security:injection_detected", (e) => {
      logger.warn({ tool: e.tool_name }, "Potential prompt injection detected");
    });

    r.events.on("budget:warning", () => {
      logger.warn("Approaching token budget (80%)");
    });

    r.events.on("budget:exceeded", () => {
      logger.error("Token budget exceeded — stopping");
    });

    r.events.on("hitl:requested", (e) => {
      spinner.stop();
      if (streaming) {
        process.stdout.write("\n");
        streaming = false;
      }
      console.log();
      console.log(
        chalk.yellow(
          "  " + chalk.bold("[Agent needs input]") + " " + e.question,
        ),
      );
      if (e.options) {
        e.options.forEach((opt, i) => {
          console.log(chalk.yellow("    " + (i + 1) + ". " + opt));
        });
      }
      void rl.question(chalk.yellow("  > ")).then((answer) => {
        runtime.answer(e.session_id, answer.trim());
      });
    });
  }

  // --- Watch mode wiring ---------------------------------------------------
  // Scope: set up a ReactiveScore that reloads the score file on change
  // and surfaces status to the REPL. The REPL checks `pendingReload`
  // between turns (so we never interrupt a mid-turn call) and swaps
  // `runtime` when appropriate.
  let reactive: ReactiveScore | undefined;
  if (options.watch) {
    reactive = new ReactiveScore(score, file);
    reactive.on("file-change", () => {
      console.log(chalk.cyan("\n[tutti] Score changed, reloading..."));
    });
    reactive.on("reloaded", () => {
      // Defer the actual swap to the next turn boundary — the REPL loop
      // checks `pendingReload` before each iteration. Applying mid-turn
      // would either interrupt a tool call or strand events listeners
      // pointing at the old runtime instance.
      console.log(chalk.green("[tutti] Score reloaded. Changes applied."));
    });
    reactive.on("reload-failed", (err) => {
      logger.error(
        { error: err instanceof Error ? err.message : String(err) },
        "[tutti] Reload failed — using previous config",
      );
    });
  }

  // Mute info-level logs during the REPL. The event listeners already
  // provide all the UX (spinner, streaming text, tool names). Letting
  // the core + CLI loggers emit info lines ("Runtime initialized",
  // "Agent started", "Running agent", …) causes pino-pretty's async
  // output to interleave with readline's `> ` prompt — making it look
  // like the process exited when it's actually waiting for input.
  coreLogger.level = "warn";
  logger.level = "warn";

  // REPL
  console.log(chalk.dim('Tutti REPL — type "exit" to quit\n'));
  if (options.watch) {
    console.log(chalk.dim("Watching " + file + " for changes…\n"));
  }

  let sessionId: string | undefined;

  // Handle Ctrl+C cleanly
  process.on("SIGINT", () => {
    if (streaming) process.stdout.write("\n");
    spinner.stop();
    console.log(chalk.dim("Goodbye!"));
    rl.close();
    if (reactive) void reactive.close();
    process.exit(0);
  });

  try {
    while (true) {
      // Apply any pending hot-reload before we start the next turn. This
      // is the "don't interrupt mid-tool-call" guarantee — we only swap
      // at a REPL-loop boundary, after the previous `run()` resolved.
      if (reactive?.pendingReload) {
        const nextScore = reactive.current;
        applyRunDefaults(nextScore);
        runtime = buildRuntime(nextScore, sharedSessions);
        attachListeners(runtime);
        reactive.consumePendingReload();
      }

      const input = await rl.question(chalk.cyan("> "));
      const trimmed = input.trim();

      if (!trimmed) continue;
      if (trimmed === "exit" || trimmed === "quit") break;

      // Reset streaming state for this run
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
        logger.error(
          { error: err instanceof Error ? err.message : String(err) },
          "Something went wrong",
        );
      }
    }
  } catch {
    // readline closed
  }

  console.log(chalk.dim("Goodbye!"));
  rl.close();
  if (reactive) await reactive.close();
  process.exit(0);
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
