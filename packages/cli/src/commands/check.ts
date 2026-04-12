import { existsSync } from "node:fs";
import { resolve } from "node:path";
import chalk from "chalk";
import {
  ScoreLoader,
  AnthropicProvider,
  OpenAIProvider,
  GeminiProvider,
  SecretsManager,
  createLogger,
} from "@tuttiai/core";

const logger = createLogger("tutti-cli");

const ok = (msg: string) => console.log(chalk.green("  \u2714 " + msg));
const fail = (msg: string) => console.log(chalk.red("  \u2718 " + msg));

export async function checkCommand(scorePath?: string): Promise<void> {
  const file = resolve(scorePath ?? "./tutti.score.ts");

  console.log(chalk.cyan(`\nChecking ${file}...\n`));

  if (!existsSync(file)) {
    fail("Score file not found: " + file);
    process.exit(1);
  }

  // 1. Load and validate
  let score;
  try {
    score = await ScoreLoader.load(file);
    ok("Score file is valid");
  } catch (err) {
    fail("Score validation failed");
    logger.error(
      { error: err instanceof Error ? err.message : String(err) },
      "Score validation failed",
    );
    process.exit(1);
  }

  let hasErrors = false;

  // 2. Check provider and API key
  const providerChecks: [unknown, string, string][] = [
    [AnthropicProvider, "AnthropicProvider", "ANTHROPIC_API_KEY"],
    [OpenAIProvider, "OpenAIProvider", "OPENAI_API_KEY"],
    [GeminiProvider, "GeminiProvider", "GEMINI_API_KEY"],
  ];

  let providerDetected = false;
  for (const [ProviderClass, name, envVar] of providerChecks) {
    if (
      score.provider instanceof
      (ProviderClass as new (...args: unknown[]) => unknown)
    ) {
      providerDetected = true;
      const key = SecretsManager.optional(envVar);
      if (key) {
        ok("Provider: " + name + " (" + envVar + " is set)");
      } else {
        fail("Provider: " + name + " (" + envVar + " is NOT set)");
        hasErrors = true;
      }
    }
  }

  if (!providerDetected) {
    ok("Provider: custom LLMProvider");
  }

  // 3. Count agents
  const agentKeys = Object.keys(score.agents);
  ok(agentKeys.length + " agent" + (agentKeys.length === 1 ? "" : "s") + " configured");

  // 4. Check voices
  for (const [agentKey, agent] of Object.entries(score.agents)) {
    for (const voice of agent.voices) {
      const voiceName = voice.name;

      // Check for known voices and their env vars
      const voiceEnvMap: Record<string, string> = {
        github: "GITHUB_TOKEN",
      };

      const envVar = voiceEnvMap[voiceName];
      if (envVar) {
        const key = SecretsManager.optional(envVar);
        if (key) {
          ok(
            "Voice: " + voiceName + " on " + agentKey + " (" + envVar + " is set)",
          );
        } else {
          fail(
            "Voice: " + voiceName + " on " + agentKey + " (" + envVar + " is NOT set)",
          );
          hasErrors = true;
        }
      } else {
        ok("Voice: " + voiceName + " on " + agentKey + " (installed)");
      }
    }
  }

  // Final summary
  console.log("");
  if (hasErrors) {
    console.log(
      chalk.yellow("Some checks failed. Fix the issues above and re-run."),
    );
    process.exit(1);
  } else {
    console.log(
      chalk.green("All checks passed.") +
        chalk.dim(" Run tutti-ai run to start."),
    );
  }
}
