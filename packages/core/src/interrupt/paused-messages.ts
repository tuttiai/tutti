/**
 * Reading a pause checkpoint's messages back as the history, the assistant's
 * `tool_use` message and the results already finished. Pure.
 *
 * @module
 */

import type { ChatMessage, ToolResultBlock, ToolUseBlock } from "@tuttiai/types";

/** A pause checkpoint's messages, split at the paused turn. */
export interface SplitMessages {
  history: ChatMessage[];
  assistant: ChatMessage;
  finished: ToolResultBlock[];
}

/**
 * Split a pause checkpoint's messages at the paused turn.
 *
 * @param messages - The checkpoint's messages.
 * @returns The split, or `undefined` when they do not end on a `tool_use` turn.
 */
export function splitPausedMessages(messages: ChatMessage[]): SplitMessages | undefined {
  const last = messages.at(-1);
  const trailing = last?.role === "user" ? 1 : 0;
  const assistant = messages.at(-1 - trailing);
  if (assistant?.role !== "assistant" || toolUses(assistant.content).length === 0) return undefined;
  const finished = trailing === 1 && last && typeof last.content !== "string"
    ? last.content.filter((b): b is ToolResultBlock => b.type === "tool_result")
    : [];
  return { history: messages.slice(0, messages.length - 1 - trailing), assistant, finished };
}

/**
 * The `tool_use` blocks of a message's content.
 *
 * @param content - A message's content.
 * @returns Its `tool_use` blocks, in order; none for plain text.
 */
export function toolUses(content: ChatMessage["content"]): ToolUseBlock[] {
  if (typeof content === "string") return [];
  return content.filter((b): b is ToolUseBlock => b.type === "tool_use");
}
