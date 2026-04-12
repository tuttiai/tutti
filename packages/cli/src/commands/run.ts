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
  createLogger,
} from "@tuttiai/core";

const logger = createLogger("tutti-cli");

export async function runCommand(scorePath?: string): Promise<void> {
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

  // Enable streaming on all agents
  for (const agent of Object.values(score.agents)) {
    agent.streaming = true;
  }

  const runtime = new TuttiRuntime(score);
  const spinner = ora({ color: "cyan" });

  // Streaming state — reset per run
  let streaming = false;

  runtime.events.on("agent:start", (e) => {
    logger.info({ agent: e.agent_name }, "Running agent");
  });

  runtime.events.on("llm:request", () => {
    spinner.start("Thinking...");
  });

  // Token-by-token streaming
  runtime.events.on("token:stream", (e) => {
    if (!streaming) {
      // First token — kill spinner, switch to streaming mode
      spinner.stop();
      streaming = true;
    }
    process.stdout.write(e.text);
  });

  runtime.events.on("llm:response", () => {
    if (streaming) {
      // End of a streamed turn — newline after the streamed text
      process.stdout.write("\n");
    } else {
      // Non-streaming fallback — just stop spinner
      spinner.stop();
    }
  });

  // Tool calls during streaming
  runtime.events.on("tool:start", (e) => {
    if (streaming) {
      process.stdout.write(chalk.dim("\n  [using: " + e.tool_name + "]"));
    } else {
      spinner.stop();
      console.log(chalk.dim("  [using: " + e.tool_name + "]"));
    }
  });

  runtime.events.on("tool:end", (e) => {
    if (streaming) {
      process.stdout.write(chalk.dim("  [done: " + e.tool_name + "]\n"));
    }
  });

  runtime.events.on("tool:error", (e) => {
    spinner.stop();
    logger.error({ tool: e.tool_name }, "Tool error");
  });

  runtime.events.on("security:injection_detected", (e) => {
    logger.warn({ tool: e.tool_name }, "Potential prompt injection detected");
  });

  runtime.events.on("budget:warning", () => {
    logger.warn("Approaching token budget (80%)");
  });

  runtime.events.on("budget:exceeded", () => {
    logger.error("Token budget exceeded — stopping");
  });

  // REPL
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log(chalk.dim('Tutti REPL — type "exit" to quit\n'));

  let sessionId: string | undefined;

  // Handle Ctrl+C cleanly
  process.on("SIGINT", () => {
    if (streaming) process.stdout.write("\n");
    spinner.stop();
    console.log(chalk.dim("Goodbye!"));
    rl.close();
    process.exit(0);
  });

  try {
    while (true) {
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
          // Non-streaming fallback — print the full response
          console.log("\n" + result.output + "\n");
        } else {
          // Streaming already printed tokens; just add a blank line
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
  process.exit(0);
}
