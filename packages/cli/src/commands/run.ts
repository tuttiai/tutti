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
} from "@tuttiai/core";

export async function runCommand(scorePath?: string): Promise<void> {
  const file = resolve(scorePath ?? "./tutti.score.ts");

  if (!existsSync(file)) {
    console.error(chalk.red(`Score file not found: ${file}`));
    console.error(
      chalk.dim('Run "tutti-ai init" to create a new project.'),
    );
    process.exit(1);
  }

  let score;
  try {
    score = await ScoreLoader.load(file);
  } catch (err) {
    console.error(
      chalk.red(
        `Failed to load score: ${err instanceof Error ? err.message : err}`,
      ),
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
        console.error(
          chalk.red(
            `Missing API key: ${envVar}\n` +
              `Add it to your .env file: ${envVar}=your_value_here`,
          ),
        );
        process.exit(1);
      }
    }
  }

  const runtime = new TuttiRuntime(score);
  const spinner = ora({ color: "cyan" });

  // Event-based execution trace
  runtime.events.on("agent:start", (e) => {
    console.log(chalk.cyan(`Running agent: ${e.agent_name}`));
  });

  runtime.events.on("llm:request", () => {
    spinner.start("Thinking...");
  });

  runtime.events.on("llm:response", () => {
    spinner.stop();
  });

  runtime.events.on("tool:start", (e) => {
    console.log(chalk.dim(`  Using tool: ${e.tool_name}`));
  });

  runtime.events.on("tool:end", (e) => {
    console.log(chalk.dim(`  Done: ${e.tool_name}`));
  });

  runtime.events.on("tool:error", (e) => {
    console.log(chalk.red(`  Error in tool: ${e.tool_name}`));
  });

  runtime.events.on("security:injection_detected", (e) => {
    console.log(
      chalk.yellow(
        `  [security] Potential prompt injection detected in: ${e.tool_name}`,
      ),
    );
  });

  runtime.events.on("budget:warning", () => {
    console.log(chalk.yellow("  Approaching token budget (80%)"));
  });

  runtime.events.on("budget:exceeded", () => {
    console.log(chalk.red("  Token budget exceeded. Stopping."));
  });

  // REPL
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log(chalk.dim('Tutti REPL — type "exit" to quit\n'));

  let sessionId: string | undefined;

  // Handle Ctrl+C
  process.on("SIGINT", () => {
    console.log(chalk.dim("\nGoodbye!"));
    rl.close();
    process.exit(0);
  });

  try {
    while (true) {
      const input = await rl.question(chalk.cyan("> "));
      const trimmed = input.trim();

      if (!trimmed) continue;
      if (trimmed === "exit" || trimmed === "quit") break;

      try {
        const result = await runtime.run("assistant", trimmed, sessionId);
        sessionId = result.session_id;
        console.log(`\n${result.output}\n`);
      } catch (err) {
        spinner.stop();
        console.error(
          chalk.red(
            `[tutti] Something went wrong: ${err instanceof Error ? err.message : err}`,
          ),
        );
        console.error(
          chalk.dim(
            'Run "tutti-ai check" to validate your score file.',
          ),
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
