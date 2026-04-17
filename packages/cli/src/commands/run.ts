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
  watch?: boolean;
  /**
   * When set, run a single turn with this prompt and exit instead of
   * entering the REPL. Useful for scripting and CI smoke tests.
   */
  prompt?: string;
}

/**
 * Write a line to stderr. Readline owns stdout; writing to stdout
 * during an agent run corrupts readline's internal cursor tracking and
 * keypress handling (backspace shows `^?`, arrows show `^[[D`). Stderr
 * still appears in the terminal but readline doesn't track it, so its
 * state stays clean between prompts.
 */
const out = (s: string): void => {
  process.stderr.write(s);
};

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

  const applyRunDefaults = (cfg: ScoreConfig): void => {
    for (const agent of Object.values(cfg.agents)) {
      agent.streaming = true;
    }
  };
  applyRunDefaults(score);

  // One-shot non-interactive mode: run a single turn with -p and exit.
  // Skip the REPL setup entirely — no readline, no spinner, no watcher.
  if (options.prompt !== undefined) {
    for (const agent of Object.values(score.agents)) {
      agent.streaming = false;
    }
    coreLogger.level = "silent";
    logger.level = "silent";
    const runtime = buildRuntime(score, undefined);
    try {
      const result = await runtime.run("assistant", options.prompt);
      process.stdout.write(result.output + "\n");
      process.exit(0);
    } catch (err) {
      process.stderr.write(
        chalk.red("Error: " + (err instanceof Error ? err.message : String(err))) +
          "\n",
      );
      process.exit(1);
    }
  }

  const sharedSessions: SessionStore | undefined = options.watch
    ? new InMemorySessionStore()
    : undefined;

  // `discardStdin: false` is critical. Ora's default behaviour uses
  // `stdin-discarder` which calls `process.stdin.setRawMode(false)` on
  // spinner.stop(). Readline needs raw mode ON to handle backspace and
  // arrow keys — once stdin-discarder flips it off, readline's keypress
  // processing breaks and the user sees literal ^? / ^[[D characters.
  const spinner = ora({ color: "cyan", stream: process.stderr, discardStdin: false });

  // Silence pino — the REPL's event listeners provide all the UX.
  coreLogger.level = "silent";
  logger.level = "silent";

  let streaming = false;
  let runtime = buildRuntime(score, sharedSessions);

  // Single readline for the entire REPL — never closed until exit.
  // All agent output goes to stderr so readline's stdout-based keypress
  // handling stays clean across turns.
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  attachListeners(runtime);

  function attachListeners(r: TuttiRuntime): void {
    r.events.on("llm:request", () => {
      spinner.start("Thinking...");
    });

    r.events.on("token:stream", (e) => {
      if (!streaming) {
        spinner.stop();
        streaming = true;
      }
      out(e.text);
    });

    r.events.on("llm:response", () => {
      if (streaming) {
        out("\n");
      } else {
        spinner.stop();
      }
    });

    r.events.on("tool:start", (e) => {
      if (streaming) {
        out(chalk.dim("\n  [using: " + e.tool_name + "]"));
      } else {
        spinner.stop();
        out(chalk.dim("  [using: " + e.tool_name + "]\n"));
      }
    });

    r.events.on("tool:end", (e) => {
      if (streaming) {
        out(chalk.dim("  [done: " + e.tool_name + "]\n"));
      }
    });

    r.events.on("tool:error", (e) => {
      spinner.stop();
      out(chalk.red("  Tool error: " + e.tool_name) + "\n");
    });

    r.events.on("budget:warning", () => {
      out(chalk.yellow("  Approaching token budget (80%)") + "\n");
    });

    r.events.on("budget:exceeded", () => {
      out(chalk.red("  Token budget exceeded — stopping") + "\n");
    });

    r.events.on("hitl:requested", (e) => {
      spinner.stop();
      if (streaming) { out("\n"); streaming = false; }
      out(
        "\n" +
        chalk.yellow("  " + chalk.bold("[Agent needs input]") + " " + e.question) +
        "\n",
      );
      if (e.options) {
        e.options.forEach((opt, i) => {
          out(chalk.yellow("    " + (i + 1) + ". " + opt) + "\n");
        });
      }
      void rl.question(chalk.yellow("  > ")).then((answer) => {
        runtime.answer(e.session_id, answer.trim());
      });
    });
  }

  // --- Watch mode ---
  let reactive: ReactiveScore | undefined;
  if (options.watch) {
    reactive = new ReactiveScore(score, file);
    reactive.on("file-change", () => {
      out(chalk.cyan("\n[tutti] Score changed, reloading...") + "\n");
    });
    reactive.on("reloaded", () => {
      out(chalk.green("[tutti] Score reloaded. Changes applied.") + "\n");
    });
    reactive.on("reload-failed", (err) => {
      out(
        chalk.red("[tutti] Reload failed — " +
          (err instanceof Error ? err.message : String(err))) + "\n",
      );
    });
  }

  // REPL
  out(chalk.dim('Tutti REPL — type "exit" to quit') + "\n\n");
  if (options.watch) {
    out(chalk.dim("Watching " + file + " for changes…") + "\n\n");
  }

  let sessionId: string | undefined;
  const keepalive = setInterval(() => {}, 60_000);

  let shuttingDown = false;

  // Central shutdown path. `exit` / `quit` and SIGINT both route through
  // this to make sure the terminal is actually usable afterwards:
  //   - readline is closed
  //   - stdin raw mode (set by readline + ora) is restored
  //   - stdin is unpaused so process.exit can actually flush
  //   - the ora spinner stops and restores the cursor
  // Without the raw-mode restore the shell appears "stuck" after exit —
  // the process has ended but the TTY is still in a half-raw state.
  const shutdown = (code: number): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(keepalive);
    if (streaming) out("\n");
    spinner.stop();
    out(chalk.dim("Goodbye!") + "\n");
    try {
      rl.close();
    } catch {
      // ignore
    }
    if (process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(false);
      } catch {
        // ignore
      }
    }
    process.stdin.pause();
    if (reactive) void reactive.close();
    process.exit(code);
  };

  process.on("SIGINT", () => shutdown(0));

  try {
    while (true) {
      if (reactive?.pendingReload) {
        const nextScore = reactive.current;
        applyRunDefaults(nextScore);
        runtime = buildRuntime(nextScore, sharedSessions);
        attachListeners(runtime);
        reactive.consumePendingReload();
      }

      spinner.stop();
      const input = await rl.question(chalk.cyan("> "));
      const trimmed = input.trim();

      if (!trimmed) continue;
      if (trimmed === "exit" || trimmed === "quit") {
        shutdown(0);
        return;
      }

      streaming = false;

      try {
        const result = await runtime.run("assistant", trimmed, sessionId);
        sessionId = result.session_id;

        if (!streaming) {
          out("\n" + result.output + "\n\n");
        } else {
          out("\n");
        }
      } catch (err) {
        if (streaming) out("\n");
        spinner.stop();
        out(
          chalk.red("  Error: " +
            (err instanceof Error ? err.message : String(err))) + "\n",
        );
      }
    }
  } catch (err) {
    if (err instanceof Error && err.message !== "readline was closed") {
      out(chalk.red("REPL error: " + err.message) + "\n");
    }
  }

  shutdown(0);
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
