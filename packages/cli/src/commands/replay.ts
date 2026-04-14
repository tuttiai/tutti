/**
 * `tutti-ai replay <session-id>` — time-travel debugger for sessions.
 *
 * Loads all messages for a session from the PostgreSQL session store,
 * then opens an interactive REPL for navigating, inspecting, replaying,
 * and exporting the conversation history.
 */

import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import chalk from "chalk";
import ora from "ora";
import {
  PostgresSessionStore,
  ScoreLoader,
  TuttiRuntime,
  SecretsManager,
  createLogger,
} from "@tuttiai/core";
import type { ChatMessage, Session } from "@tuttiai/types";

const logger = createLogger("tutti-cli");

// ── Rendering helpers (exported for testing) ─────────────────

/** Convert a message's content to a single-line text summary. */
export function messageToText(msg: ChatMessage): string {
  if (typeof msg.content === "string") return msg.content;
  const parts: string[] = [];
  for (const block of msg.content) {
    if (block.type === "text") {
      parts.push(block.text);
    } else if (block.type === "tool_use") {
      parts.push("[tool_use " + block.name + "]");
    } else if (block.type === "tool_result") {
      const preview = block.content.replace(/\s+/g, " ").trim();
      parts.push("[tool_result " + (preview.length > 60 ? preview.slice(0, 59) + "\u2026" : preview) + "]");
    }
  }
  return parts.join(" ");
}

/** Excerpt a string to a maximum length. */
function excerpt(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + "\u2026" : oneLine;
}

/** Render the `list` view — all messages with index, role, and preview. */
export function renderList(messages: ChatMessage[]): string {
  const lines: string[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    const role = msg.role === "user"
      ? chalk.blue("user     ")
      : chalk.green("assistant");
    const text = excerpt(messageToText(msg), 80);
    lines.push(
      chalk.dim(String(i).padStart(3)) + "  " + role + "  " + text,
    );
  }
  return lines.join("\n");
}

/** Render the `show <n>` view — full detail for one message. */
export function renderShow(messages: ChatMessage[], index: number): string {
  if (index < 0 || index >= messages.length) {
    return chalk.red("Index out of range. Valid: 0–" + (messages.length - 1));
  }

  const msg = messages[index]!;
  const lines: string[] = [];

  lines.push(chalk.cyan.bold("Turn " + index) + "  " + chalk.dim("[" + msg.role + "]"));
  lines.push("");

  if (typeof msg.content === "string") {
    lines.push(msg.content);
  } else {
    for (const block of msg.content) {
      if (block.type === "text") {
        lines.push(block.text);
      } else if (block.type === "tool_use") {
        lines.push(chalk.yellow("  tool_use: " + block.name));
        lines.push(chalk.dim("  id: " + block.id));
        lines.push(chalk.dim("  input: " + JSON.stringify(block.input, null, 2)));
      } else if (block.type === "tool_result") {
        const label = block.is_error ? chalk.red("  tool_result (error):") : chalk.green("  tool_result:");
        lines.push(label);
        lines.push(chalk.dim("  tool_use_id: " + block.tool_use_id));
        lines.push("  " + block.content);
      }
    }
  }

  return lines.join("\n");
}

/** Render the `inspect` view — raw JSON of the current message. */
export function renderInspect(messages: ChatMessage[], index: number): string {
  if (index < 0 || index >= messages.length) {
    return chalk.red("Index out of range.");
  }
  return JSON.stringify(messages[index], null, 2);
}

/** Export the session as JSON. */
export function exportJSON(session: Session): string {
  return JSON.stringify(
    {
      id: session.id,
      agent_name: session.agent_name,
      created_at: session.created_at,
      messages: session.messages,
    },
    null,
    2,
  );
}

/** Export the session as Markdown. */
export function exportMarkdown(session: Session): string {
  const lines: string[] = [];
  lines.push("# Session " + session.id);
  lines.push("");
  lines.push("**Agent:** " + session.agent_name);
  lines.push("**Created:** " + session.created_at.toISOString());
  lines.push("**Messages:** " + session.messages.length);
  lines.push("");
  lines.push("---");
  lines.push("");

  for (let i = 0; i < session.messages.length; i++) {
    const msg = session.messages[i]!;
    lines.push("## Turn " + i + " (" + msg.role + ")");
    lines.push("");
    if (typeof msg.content === "string") {
      lines.push(msg.content);
    } else {
      for (const block of msg.content) {
        if (block.type === "text") {
          lines.push(block.text);
        } else if (block.type === "tool_use") {
          lines.push("**Tool call:** `" + block.name + "`");
          lines.push("```json\n" + JSON.stringify(block.input, null, 2) + "\n```");
        } else if (block.type === "tool_result") {
          const label = block.is_error ? "**Tool error:**" : "**Tool result:**";
          lines.push(label);
          lines.push("```\n" + block.content + "\n```");
        }
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ── REPL ─────────────────────────────────────────────────────

export interface ReplayOptions {
  score?: string;
}

export async function replayCommand(
  sessionId: string,
  opts: ReplayOptions = {},
): Promise<void> {
  const pgUrl = SecretsManager.optional("TUTTI_PG_URL");
  if (!pgUrl) {
    console.error(chalk.red("TUTTI_PG_URL is not set."));
    console.error(
      chalk.dim(
        "The replay command requires PostgreSQL for session persistence.\n" +
          "Set TUTTI_PG_URL=postgres://user:pass@host/db in your environment.",
      ),
    );
    process.exit(1);
  }

  const store = new PostgresSessionStore(pgUrl);

  const spinner = ora({ color: "cyan" }).start("Loading session...");
  let session: Session | undefined;
  try {
    session = await store.getAsync(sessionId);
  } catch (err) {
    spinner.fail("Failed to load session");
    logger.error(
      { error: err instanceof Error ? err.message : String(err) },
      "Session store error",
    );
    process.exit(1);
  }
  spinner.stop();

  if (!session) {
    console.error(chalk.red("Session not found: " + sessionId));
    console.error(chalk.dim("Check the session ID and ensure TUTTI_PG_URL points to the correct database."));
    await store.close();
    process.exit(1);
  }

  const messages = session.messages;

  console.log("");
  console.log(chalk.cyan.bold("  Tutti Replay"));
  console.log(chalk.dim("  Session: " + session.id));
  console.log(chalk.dim("  Agent:   " + session.agent_name));
  console.log(chalk.dim("  Created: " + session.created_at.toISOString()));
  console.log(chalk.dim("  Messages: " + messages.length));
  console.log("");
  console.log(chalk.dim("  Commands: list, show <n>, next, prev, inspect, replay-from <n>, export <json|md>, quit"));
  console.log("");

  let cursor = 0;

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    while (true) {
      const prompt = chalk.cyan("replay [" + cursor + "/" + (messages.length - 1) + "]> ");
      const raw = await rl.question(prompt);
      const input = raw.trim();
      if (!input) continue;

      const [cmd, ...args] = input.split(/\s+/);

      switch (cmd) {
        case "quit":
        case "exit":
        case "q":
          console.log(chalk.dim("Bye."));
          return;

        case "list":
          console.log(renderList(messages));
          break;

        case "show": {
          const n = parseInt(args[0] ?? String(cursor), 10);
          console.log(renderShow(messages, n));
          if (n >= 0 && n < messages.length) cursor = n;
          break;
        }

        case "next":
          if (cursor < messages.length - 1) {
            cursor++;
            console.log(renderShow(messages, cursor));
          } else {
            console.log(chalk.dim("Already at last message."));
          }
          break;

        case "prev":
          if (cursor > 0) {
            cursor--;
            console.log(renderShow(messages, cursor));
          } else {
            console.log(chalk.dim("Already at first message."));
          }
          break;

        case "inspect":
          console.log(renderInspect(messages, cursor));
          break;

        case "replay-from": {
          const turn = parseInt(args[0] ?? "", 10);
          if (isNaN(turn) || turn < 0 || turn >= messages.length) {
            console.log(chalk.red("Usage: replay-from <turn-number>"));
            break;
          }
          await handleReplayFrom(turn, session, rl, opts);
          break;
        }

        case "export": {
          const format = args[0];
          if (format === "json") {
            const filename = "session-" + session.id.slice(0, 8) + ".json";
            await writeFile(filename, exportJSON(session));
            console.log(chalk.green("Exported to " + filename));
          } else if (format === "md" || format === "markdown") {
            const filename = "session-" + session.id.slice(0, 8) + ".md";
            await writeFile(filename, exportMarkdown(session));
            console.log(chalk.green("Exported to " + filename));
          } else {
            console.log(chalk.dim("Usage: export <json|md>"));
          }
          break;
        }

        default:
          console.log(
            chalk.dim("Unknown command. Available: list, show <n>, next, prev, inspect, replay-from <n>, export <json|md>, quit"),
          );
      }
    }
  } finally {
    rl.close();
    await store.close();
  }
}

// ── replay-from ──────────────────────────────────────────────

async function handleReplayFrom(
  turn: number,
  session: Session,
  rl: ReturnType<typeof createInterface>,
  opts: ReplayOptions,
): Promise<void> {
  const scoreFile = resolve(opts.score ?? "./tutti.score.ts");
  if (!existsSync(scoreFile)) {
    console.log(chalk.red("Score file not found: " + scoreFile));
    console.log(chalk.dim("Use --score to specify the score file."));
    return;
  }

  // Original input at that turn
  const originalMsg = session.messages[turn];
  const originalInput = originalMsg ? messageToText(originalMsg) : "";

  const answer = await rl.question(
    chalk.cyan("Replay from turn " + turn + " with original input? ") +
      chalk.dim("(y / enter new input) "),
  );

  const input = answer.trim().toLowerCase() === "y" || answer.trim() === ""
    ? originalInput
    : answer.trim();

  if (!input) {
    console.log(chalk.dim("No input provided. Cancelled."));
    return;
  }

  const spinnerLoad = ora({ color: "cyan" }).start("Loading score...");
  let score;
  try {
    score = await ScoreLoader.load(scoreFile);
  } catch (err) {
    spinnerLoad.fail("Failed to load score");
    logger.error({ error: err instanceof Error ? err.message : String(err) }, "Score load error");
    return;
  }
  spinnerLoad.stop();

  // Restore messages up to the turn
  const restoredMessages = session.messages.slice(0, turn);

  const runtime = new TuttiRuntime(score);

  // Seed the session
  const sessions = runtime.sessions;
  if ("save" in sessions && typeof sessions.save === "function") {
    (sessions.save as (s: {
      id: string;
      agent_name: string;
      messages: typeof restoredMessages;
      created_at: Date;
      updated_at: Date;
    }) => void)({
      id: session.id,
      agent_name: session.agent_name,
      messages: restoredMessages,
      created_at: session.created_at,
      updated_at: new Date(),
    });
  }

  const agentName = session.agent_name;
  const agent = score.agents[agentName];
  if (!agent) {
    console.log(chalk.red("Agent \"" + agentName + "\" not found in score."));
    return;
  }

  const spinnerRun = ora({ color: "cyan" }).start("Running from turn " + turn + "...");

  runtime.events.on("token:stream", (e) => {
    spinnerRun.stop();
    process.stdout.write(e.text);
  });

  try {
    const result = await runtime.run(agentName, input, session.id);
    spinnerRun.stop();
    console.log("");
    console.log(chalk.green("Replay complete."));
    console.log(chalk.dim("  Turns: " + result.turns));
    console.log(chalk.dim("  Tokens: " + result.usage.input_tokens + " in / " + result.usage.output_tokens + " out"));
    console.log("");
    console.log(result.output);
  } catch (err) {
    spinnerRun.fail("Replay failed");
    logger.error({ error: err instanceof Error ? err.message : String(err) }, "Replay error");
  }
}
