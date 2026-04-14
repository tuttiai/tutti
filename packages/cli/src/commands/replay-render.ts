/**
 * Pure rendering functions for the replay command.
 *
 * Split from `replay.ts` so they stay in the coverage scope while
 * the interactive REPL and Postgres I/O are excluded.
 */

import chalk from "chalk";
import type { ChatMessage, Session } from "@tuttiai/types";

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
    const msg = messages.at(i);
    if (!msg) continue;
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
    return chalk.red("Index out of range. Valid: 0\u2013" + (messages.length - 1));
  }

  const msg = messages.at(index);
  if (!msg) return chalk.red("Index out of range.");
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
  return JSON.stringify(messages.at(index), null, 2);
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
    const msg = session.messages.at(i);
    if (!msg) continue;
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
