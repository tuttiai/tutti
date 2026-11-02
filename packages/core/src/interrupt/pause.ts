/**
 * Pause checkpoints: what a run saves when a tool call stops at the approval
 * gate, and how a later process plans to finish that turn from it.
 *
 * A pause checkpoint is an ordinary {@link Checkpoint} with
 * `state.awaiting_tool_results: false` and `state.pending_tool_ids` naming
 * the tool calls of the paused turn that had not finished. Its messages end
 * with the assistant's `tool_use` message, followed by a user message of the
 * `tool_result`s already finished when there are any. The durable resume in
 * `AgentRunner` only takes `awaiting_tool_results: true` checkpoints, so it
 * never mistakes one of these for its own.
 *
 * Everything here is pure: no store, no clock, no logger.
 *
 * @module
 */

import { isDeepStrictEqual } from "node:util";

import type {
  ChatMessage,
  ChatResponse,
  ContentBlock,
  TokenUsage,
  ToolResultBlock,
  ToolUseBlock,
} from "@tuttiai/types";

import type { Checkpoint } from "../checkpoint/types.js";
import type { InterruptRequest } from "./types.js";

/** What a resumed turn does with one of its tool calls. */
export type Disposition =
  | { kind: "done"; result: ToolResultBlock }
  | { kind: "approved" }
  | { kind: "denied"; record: InterruptRequest }
  | { kind: "interrupted" };

/** A paused turn, ready to be replayed by the runner without a model call. */
export interface PausedTurn {
  session_id: string;
  /** The turn number that paused. */
  turn: number;
  /** The history before the assistant's `tool_use` message. */
  messages: ChatMessage[];
  /** The assistant's response that asked for the tools, replayed as is. */
  response: ChatResponse;
  /** One entry per `tool_use` id of the paused turn. */
  dispositions: Map<string, Disposition>;
  /** Tokens the run had used when it paused. */
  usage: TokenUsage;
}

/** The outcome of {@link planResume}. */
export type ResumePlan =
  | { kind: "replay"; turn: PausedTurn }
  | { kind: "wait" }
  | { kind: "invalid" };

/** What {@link buildPauseCheckpoint} needs. */
export interface PauseSnapshot {
  session_id: string;
  turn: number;
  /** History up to and including the assistant's `tool_use` message. */
  messages: ChatMessage[];
  /** Results of the turn's calls that have finished, in call order. */
  finished: ToolResultBlock[];
  /** `tool_use` ids that have not finished. */
  pending: string[];
  usage: TokenUsage;
  /** When the turn first paused. Kept on every rewrite of the checkpoint. */
  saved_at: Date;
}

/**
 * Build the pause checkpoint for a turn.
 *
 * @param snap - The turn's state.
 * @returns A checkpoint `planResume` can read back.
 */
export function buildPauseCheckpoint(snap: PauseSnapshot): Checkpoint {
  const messages = [...snap.messages];
  if (snap.finished.length > 0) messages.push({ role: "user", content: [...snap.finished] });
  return {
    session_id: snap.session_id,
    turn: snap.turn,
    messages,
    tool_results: snap.finished.map((r) => ({ content: r.content, ...(r.is_error ? { is_error: true } : {}) })),
    state: {
      next_turn: snap.turn + 1,
      prompt_tokens_used: snap.usage.input_tokens,
      completion_tokens_used: snap.usage.output_tokens,
      pending_tool_ids: [...snap.pending],
      awaiting_tool_results: false,
    },
    saved_at: snap.saved_at,
  };
}

/**
 * Whether a checkpoint is a pause checkpoint.
 *
 * @param cp - Any checkpoint.
 * @returns `true` when it marks a turn stopped at the approval gate.
 */
export function isPauseCheckpoint(cp: Checkpoint): boolean {
  return cp.state.awaiting_tool_results === false && (cp.state.pending_tool_ids?.length ?? 0) > 0;
}

/**
 * Plan how to finish a paused turn.
 *
 * Each unfinished call is matched to an approval record of the same session
 * and tool with equal arguments, oldest record first, among the records
 * created since the turn paused. A matched record still pending means wait;
 * a denied one ends the run; approved ones run. An unfinished call with no
 * record was running when the process stopped and is never run again.
 *
 * @param cp - A pause checkpoint.
 * @param records - The session's approval records, in any order.
 * @returns `replay`, `wait`, or `invalid` when the checkpoint cannot be read as a paused turn.
 */
export function planResume(cp: Checkpoint, records: InterruptRequest[]): ResumePlan {
  const split = splitPausedMessages(cp.messages);
  if (!isPauseCheckpoint(cp) || !split) return { kind: "invalid" };
  const pending = new Set(cp.state.pending_tool_ids);
  const candidates = records
    .filter((r) => r.session_id === cp.session_id && r.requested_at.getTime() >= cp.saved_at.getTime())
    .sort((a, b) => a.requested_at.getTime() - b.requested_at.getTime());
  const decided = new Map<string, Disposition | "wait">();
  for (const block of toolUses(split.assistant.content)) {
    const done = split.finished.find((r) => r.tool_use_id === block.id);
    if (done) decided.set(block.id, { kind: "done", result: done });
    else if (pending.has(block.id)) decided.set(block.id, claim(block, candidates));
    else return { kind: "invalid" };
  }
  const dispositions = settle(decided);
  return dispositions ? { kind: "replay", turn: toPausedTurn(cp, split, dispositions) } : { kind: "wait" };
}

/**
 * A denial ends the run as a live one does, even while a sibling call still
 * waits; its waiting siblings are then never run. Without a denial, any call
 * still waiting holds the whole turn back.
 */
function settle(decided: Map<string, Disposition | "wait">): Map<string, Disposition> | undefined {
  const values = [...decided.values()];
  const denied = values.some((d) => d !== "wait" && d.kind === "denied");
  if (!denied && values.includes("wait")) return undefined;
  const settled = new Map<string, Disposition>();
  for (const [id, d] of decided) settled.set(id, d === "wait" ? { kind: "interrupted" } : d);
  return settled;
}

interface SplitMessages {
  history: ChatMessage[];
  assistant: ChatMessage;
  finished: ToolResultBlock[];
}

function splitPausedMessages(messages: ChatMessage[]): SplitMessages | undefined {
  const last = messages.at(-1);
  const trailing = last?.role === "user" ? 1 : 0;
  const assistant = messages.at(-1 - trailing);
  if (assistant?.role !== "assistant" || toolUses(assistant.content).length === 0) return undefined;
  const finished = trailing === 1 && last && typeof last.content !== "string"
    ? last.content.filter((b): b is ToolResultBlock => b.type === "tool_result")
    : [];
  return { history: messages.slice(0, messages.length - 1 - trailing), assistant, finished };
}

function toolUses(content: ChatMessage["content"]): ToolUseBlock[] {
  if (typeof content === "string") return [];
  return content.filter((b): b is ToolUseBlock => b.type === "tool_use");
}

function claim(block: ToolUseBlock, candidates: InterruptRequest[]): Disposition | "wait" {
  const index = candidates.findIndex(
    (r) => r.tool_name === block.name && isDeepStrictEqual(r.tool_args, block.input),
  );
  if (index < 0) return { kind: "interrupted" };
  const [record] = candidates.splice(index, 1);
  if (record === undefined || record.status === "pending") return "wait";
  return record.status === "approved" ? { kind: "approved" } : { kind: "denied", record };
}

function toPausedTurn(cp: Checkpoint, split: SplitMessages, dispositions: Map<string, Disposition>): PausedTurn {
  const content: ContentBlock[] = typeof split.assistant.content === "string" ? [] : split.assistant.content;
  return {
    session_id: cp.session_id,
    turn: cp.turn,
    messages: split.history,
    response: { id: "", content, stop_reason: "tool_use", usage: { input_tokens: 0, output_tokens: 0 } },
    dispositions,
    usage: { input_tokens: cp.state.prompt_tokens_used, output_tokens: cp.state.completion_tokens_used },
  };
}
