import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import chalk from "chalk";
import ora from "ora";
import {
  AnthropicProvider,
  GeminiProvider,
  OpenAIProvider,
  ScoreLoader,
  SecretsManager,
  TuttiRuntime,
  createCheckpointStore,
  type Checkpoint,
  type ChatMessage,
} from "@tuttiai/core";
import { logger } from "../logger.js";

export interface ResumeOptions {
  /** Which durable store the checkpoint was written to. */
  store: "redis" | "postgres";
  /** Path to the score file (defaults to ./tutti.score.ts). */
  score?: string;
  /** Agent key to resume; defaults to the score's entry agent. */
  agent?: string;
  /** Skip the confirmation prompt — for scripted use. */
  yes?: boolean;
}

export async function resumeCommand(
  sessionId: string,
  opts: ResumeOptions,
): Promise<void> {
  // --- Score loading (same flow as `run`) -------------------------------
  const scoreFile = resolve(opts.score ?? "./tutti.score.ts");
  if (!existsSync(scoreFile)) {
    logger.error({ file: scoreFile }, "Score file not found");
    console.error(chalk.dim('Run "tutti-ai init" to create a new project.'));
    process.exit(1);
  }

  let score;
  try {
    score = await ScoreLoader.load(scoreFile);
  } catch (err) {
    logger.error(
      { error: err instanceof Error ? err.message : String(err) },
      "Failed to load score",
    );
    process.exit(1);
  }

  // --- Provider API-key check (same shortlist as `run`) -----------------
  const providerKeyMap: [unknown, string][] = [
    [AnthropicProvider, "ANTHROPIC_API_KEY"],
    [OpenAIProvider, "OPENAI_API_KEY"],
    [GeminiProvider, "GEMINI_API_KEY"],
  ];
  for (const [ProviderClass, envVar] of providerKeyMap) {
    if (
      score.provider instanceof
      (ProviderClass as new (...args: unknown[]) => unknown)
    ) {
      if (!SecretsManager.optional(envVar)) {
        logger.error({ envVar }, "Missing API key");
        process.exit(1);
      }
    }
  }

  // --- Resolve the target agent -----------------------------------------
  const agentName = resolveAgentName(score, opts.agent);
  const agentMap = new Map(Object.entries(score.agents));
  const agent = agentMap.get(agentName);
  if (!agent) {
    logger.error(
      { agent: agentName, available: Object.keys(score.agents) },
      "Agent not found in score",
    );
    process.exit(1);
  }
  if (!agent.durable) {
    console.error(
      chalk.yellow(
        "Agent '" +
          agentName +
          "' does not have `durable: true` set — resume has nothing to restore.",
      ),
    );
    console.error(
      chalk.dim(
        "Enable durable checkpointing on the agent before the run that created this session.",
      ),
    );
    process.exit(1);
  }

  // --- Load the checkpoint ----------------------------------------------
  const spinner = ora({ color: "cyan" }).start("Loading checkpoint...");
  let checkpointStore;
  let checkpoint: Checkpoint | null;
  try {
    checkpointStore = createCheckpointStore({ store: opts.store });
    checkpoint = await checkpointStore.loadLatest(sessionId);
  } catch (err) {
    spinner.fail("Failed to load checkpoint");
    logger.error(
      { error: err instanceof Error ? err.message : String(err), store: opts.store },
      "Checkpoint store error",
    );
    process.exit(1);
  }
  spinner.stop();

  if (!checkpoint) {
    console.error(
      chalk.red("No checkpoint found for session " + sessionId + "."),
    );
    console.error(
      chalk.dim(
        "Verify TUTTI_" +
          (opts.store === "redis" ? "REDIS" : "PG") +
          "_URL points to the same " +
          opts.store +
          " the original run used.",
      ),
    );
    process.exit(1);
  }

  // --- Render the summary -----------------------------------------------
  printSummary(checkpoint);

  // --- Confirm (unless --yes) -------------------------------------------
  if (!opts.yes && !(await confirmResume(checkpoint.turn))) {
    console.log(chalk.dim("Cancelled."));
    process.exit(0);
  }

  // --- Build the runtime and hand off to AgentRunner --------------------
  const runtime = new TuttiRuntime(score, { checkpointStore });

  // Seed the session store with a synthetic Session so the runner's
  // `sessions.get(id)` lookup succeeds. The agent loop immediately
  // overwrites `messages` from the checkpoint — the seeded messages
  // array only exists so the initial get() call doesn't miss.
  const sessions = runtime.sessions;
  if ("save" in sessions && typeof sessions.save === "function") {
    (sessions.save as (s: { id: string; agent_name: string; messages: ChatMessage[]; created_at: Date; updated_at: Date }) => void)({
      id: sessionId,
      agent_name: agentName,
      messages: [...checkpoint.messages],
      created_at: checkpoint.saved_at,
      updated_at: new Date(),
    });
  } else {
    console.error(
      chalk.red(
        "Session store does not support resume seeding. Use the default InMemorySessionStore or PostgresSessionStore.",
      ),
    );
    process.exit(1);
  }

  wireProgress(runtime);

  try {
    // Input is ignored when the runner sees a mid-cycle checkpoint, but
    // we still need a non-empty value to satisfy the method signature.
    const result = await runtime.run(agentName, "[resume]", sessionId);
    console.log();
    console.log(chalk.green("✓ Resumed run complete."));
    console.log(chalk.dim("  Final turn:    " + result.turns));
    console.log(chalk.dim("  Session ID:    " + result.session_id));
    console.log(
      chalk.dim(
        "  Token usage:   " +
          result.usage.input_tokens +
          " in / " +
          result.usage.output_tokens +
          " out",
      ),
    );
    console.log();
    console.log(result.output);
  } catch (err) {
    logger.error(
      { error: err instanceof Error ? err.message : String(err) },
      "Resume failed",
    );
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveAgentName(
  score: { entry?: string | { agents: string[] }; agents: Record<string, unknown> },
  override?: string,
): string {
  if (override) return override;
  if (typeof score.entry === "string") return score.entry;
  const first = Object.keys(score.agents)[0];
  if (!first) {
    console.error(chalk.red("Score has no agents defined."));
    process.exit(1);
  }
  return first;
}

function printSummary(checkpoint: Checkpoint): void {
  console.log();
  console.log(chalk.cyan.bold("Checkpoint summary"));
  console.log(
    chalk.dim("  Session ID:    ") + checkpoint.session_id,
  );
  console.log(
    chalk.dim("  Last turn:     ") + String(checkpoint.turn),
  );
  console.log(
    chalk.dim("  Saved at:      ") +
      checkpoint.saved_at.toISOString(),
  );
  console.log(
    chalk.dim("  Messages:      ") +
      String(checkpoint.messages.length) +
      " total",
  );
  console.log();
  console.log(chalk.cyan("First messages"));
  const preview = checkpoint.messages.slice(0, 3);
  for (const msg of preview) {
    const text = excerpt(messageToText(msg), 200);
    console.log(chalk.dim("  [" + msg.role + "] ") + text);
  }
  if (checkpoint.messages.length > preview.length) {
    console.log(
      chalk.dim(
        "  … " +
          String(checkpoint.messages.length - preview.length) +
          " more",
      ),
    );
  }
  console.log();
}

function messageToText(msg: ChatMessage): string {
  if (typeof msg.content === "string") return msg.content;
  const parts: string[] = [];
  for (const block of msg.content) {
    if (block.type === "text") {
      parts.push(block.text);
    } else if (block.type === "tool_use") {
      parts.push("[tool_use " + block.name + "]");
    } else if (block.type === "tool_result") {
      parts.push("[tool_result " + excerpt(block.content, 80) + "]");
    }
  }
  return parts.join(" ");
}

function excerpt(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + "…" : oneLine;
}

async function confirmResume(turn: number): Promise<boolean> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = (
      await rl.question(
        chalk.cyan("Resume from turn " + turn + "? ") + chalk.dim("(y/n) "),
      )
    )
      .trim()
      .toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

function wireProgress(runtime: TuttiRuntime): void {
  const spinner = ora({ color: "cyan" });
  let streaming = false;

  runtime.events.on("checkpoint:restored", (e) => {
    console.log(
      chalk.dim("↻ Restored from turn " + e.turn) +
        chalk.dim(" (session " + e.session_id.slice(0, 8) + "…)"),
    );
  });
  runtime.events.on("checkpoint:saved", (e) => {
    console.log(chalk.dim("· Checkpoint saved at turn " + e.turn));
  });
  runtime.events.on("llm:request", () => {
    spinner.start("Thinking...");
  });
  runtime.events.on("token:stream", (e) => {
    if (!streaming) {
      spinner.stop();
      streaming = true;
    }
    process.stdout.write(e.text);
  });
  runtime.events.on("llm:response", () => {
    if (streaming) {
      process.stdout.write("\n");
    } else {
      spinner.stop();
    }
  });
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
}
