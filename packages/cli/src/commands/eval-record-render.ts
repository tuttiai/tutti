/**
 * Pure rendering + extraction helpers for `tutti-ai eval record`.
 *
 * Kept free of any I/O or prompt-driver code so it can run under unit
 * coverage. `eval-record.ts` does the session fetch, prompt orchestration,
 * and disk write; this file just shapes the data in and out.
 */

import chalk from "chalk";
import type {
  ChatMessage,
  ContentBlock,
  GoldenCase,
  ScorerRef,
  Session,
} from "@tuttiai/core";

/**
 * What the record command extracts from a session before asking the user
 * to confirm / edit. Every field is a sensible default — the prompts
 * layer overlays user choices on top.
 */
export interface SessionDraft {
  input: string;
  output: string;
  tool_sequence: string[];
}

/** Answers collected from the enquirer prompts in eval-record.ts. */
export interface RecordAnswers {
  name: string;
  /** `"actual"` = save the run's output as exact match target. */
  expected_mode: "actual" | "custom" | "skip";
  expected_output_custom?: string;
  tool_sequence: string[];
  scorers: ScorerRef[];
  tags: string[];
}

// ---------------------------------------------------------------------------
// Session → draft
// ---------------------------------------------------------------------------

/**
 * Extract the first user input, last assistant output, and ordered tool
 * sequence from a recorded session. Silent on empty sessions — the caller
 * is expected to show the summary and let the user decide whether it's
 * still worth recording.
 */
export function extractSessionDraft(session: Session): SessionDraft {
  const firstUser = session.messages.find((m) => m.role === "user");
  const lastAssistant = [...session.messages].reverse().find((m) => m.role === "assistant");

  return {
    input: firstUser ? messageText(firstUser) : "",
    output: lastAssistant ? messageText(lastAssistant) : "",
    tool_sequence: collectToolSequence(session.messages),
  };
}

/** Concatenate every text block in a message — tool_use / tool_result ignored. */
function messageText(msg: ChatMessage): string {
  if (typeof msg.content === "string") return msg.content;
  return msg.content
    .filter((b: ContentBlock): b is ContentBlock & { type: "text" } => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/** Ordered list of `tool_use.name` across every assistant message. */
function collectToolSequence(messages: ChatMessage[]): string[] {
  const seq: string[] = [];
  for (const msg of messages) {
    if (msg.role !== "assistant" || typeof msg.content === "string") continue;
    for (const block of msg.content) {
      if (block.type === "tool_use") seq.push(block.name);
    }
  }
  return seq;
}

// ---------------------------------------------------------------------------
// Summary rendering
// ---------------------------------------------------------------------------

/** 200-char truncation with an ellipsis + compact whitespace. */
export function truncate200(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > 200 ? compact.slice(0, 199) + "\u2026" : compact;
}

/**
 * Summary block printed before the prompts. `tokens === undefined` renders
 * as `—` so the absence of a checkpoint doesn't look like a bug.
 */
export function renderSessionSummary(
  session: Session,
  draft: SessionDraft,
  tokens: number | undefined,
): string {
  const lines: string[] = [];
  lines.push(chalk.cyan.bold("  Session summary"));
  lines.push(chalk.dim("  Session: ") + session.id);
  lines.push(chalk.dim("  Agent:   ") + session.agent_name);
  lines.push(chalk.dim("  Created: ") + session.created_at.toISOString());
  lines.push(chalk.dim("  Tokens:  ") + (tokens !== undefined ? String(tokens) : "\u2014"));
  lines.push("");
  lines.push(chalk.dim("  Input:   ") + truncate200(draft.input || "(empty)"));
  lines.push(chalk.dim("  Output:  ") + truncate200(draft.output || "(empty)"));
  lines.push(
    chalk.dim("  Tools:   ") +
      (draft.tool_sequence.length === 0
        ? chalk.dim("(none)")
        : draft.tool_sequence.map((t) => chalk.cyan(t)).join(chalk.dim(" \u2192 "))),
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Prompt helpers
// ---------------------------------------------------------------------------

/** First 40 chars of `input`, trimmed + whitespace-normalised. */
export function deriveDefaultCaseName(input: string): string {
  const compact = input.replace(/\s+/g, " ").trim();
  return compact.length > 40 ? compact.slice(0, 40) : compact;
}

/** Parse a comma-separated tag string — empty / whitespace entries dropped. */
export function parseTagInput(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Parse a comma- OR arrow-separated tool sequence editable by the user. */
export function parseToolSequenceInput(raw: string): string[] {
  return raw
    .split(/[,\u2192]|->/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// ---------------------------------------------------------------------------
// Draft + answers → GoldenCase
// ---------------------------------------------------------------------------

/**
 * Assemble the final {@link GoldenCase} from the session draft and the
 * user's prompt answers. `id` is left as `""` so the store assigns one;
 * `created_at` is set to `now` so the file shows when the promotion
 * happened, not when the original session ran.
 */
export function buildGoldenCase(
  session: Session,
  draft: SessionDraft,
  answers: RecordAnswers,
  now: Date = new Date(),
): GoldenCase {
  const expected_output = resolveExpectedOutput(draft, answers);

  return {
    id: "",
    name: answers.name,
    agent_id: session.agent_name,
    input: draft.input,
    ...(expected_output !== undefined ? { expected_output } : {}),
    ...(answers.tool_sequence.length > 0
      ? { expected_tool_sequence: answers.tool_sequence }
      : {}),
    scorers: answers.scorers,
    ...(answers.tags.length > 0 ? { tags: answers.tags } : {}),
    promoted_from_session: session.id,
    created_at: now,
  };
}

function resolveExpectedOutput(
  draft: SessionDraft,
  answers: RecordAnswers,
): string | undefined {
  if (answers.expected_mode === "actual") return draft.output;
  if (answers.expected_mode === "custom") return answers.expected_output_custom ?? "";
  return undefined;
}

// ---------------------------------------------------------------------------
// Success confirmation
// ---------------------------------------------------------------------------

/** One-liner printed after the case is saved. */
export function renderRecordedConfirmation(stored: GoldenCase): string {
  return (
    chalk.green("\u2713") +
    " Golden case saved: " +
    chalk.bold(stored.name) +
    chalk.dim(" (" + stored.id + "). Run `tutti-ai eval run` to test against it.")
  );
}
