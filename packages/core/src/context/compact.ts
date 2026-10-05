import type { AgentContextConfig, ChatMessage, ChatRequest, ChatResponse } from "@tuttiai/types";

import { logger } from "../logger.js";
import { summariseHistory, summaryCut } from "./summarise.js";
import { estimateTokens, trimToolResults } from "./trim.js";

const DEFAULT_KEEP_RECENT_TOOL_RESULTS = 4;
const DEFAULT_TRIMMED_CHARS = 400;
const DEFAULT_KEEP_RECENT_MESSAGES = 8;

/** What compacting a conversation needs from the runner. */
export interface CompactDeps {
  /** The agent, for logs. */
  agent_name: string;
  /** Sends one request to the agent's model, counted against the run's budget. */
  chat: (request: Omit<ChatRequest, "model">) => Promise<ChatResponse>;
}

/**
 * Shorten a conversation before a model call, per the agent's `context`
 * settings, in place: first older tool results, then, if it is still too
 * large, the older part of the conversation is summarised. A failed summary
 * is logged and the run carries on with the conversation as it was.
 *
 * @param messages - The conversation, mutated.
 * @param config - The agent's context settings.
 * @param deps - Model access and identity for logs.
 * @returns The summary call's response when one was made, for its usage.
 *
 * @example
 * const extra = await compactContext(messages, agent.context, { agent_name, chat });
 * if (extra) addUsage(totalUsage, extra.usage);
 */
export async function compactContext(
  messages: ChatMessage[],
  config: AgentContextConfig,
  deps: CompactDeps,
): Promise<ChatResponse | undefined> {
  if (config.trim_after_tokens !== undefined && estimateTokens(messages) > config.trim_after_tokens) {
    const removed = trimToolResults(
      messages,
      config.keep_recent_tool_results ?? DEFAULT_KEEP_RECENT_TOOL_RESULTS,
      config.trimmed_tool_result_chars ?? DEFAULT_TRIMMED_CHARS,
    );
    if (removed > 0) logger.info({ agent: deps.agent_name, chars_removed: removed }, "Shortened older tool results");
  }
  if (config.summarise_after_tokens === undefined) return undefined;
  const before = estimateTokens(messages);
  if (before <= config.summarise_after_tokens) return undefined;
  const cut = summaryCut(messages, config.keep_recent_messages ?? DEFAULT_KEEP_RECENT_MESSAGES);
  if (cut === undefined) return undefined;
  try {
    const response = await summariseHistory(messages, cut, deps.chat);
    logger.info({ agent: deps.agent_name, tokens_before: before, tokens_after: estimateTokens(messages) }, "Summarised older conversation");
    return response;
  } catch (err) {
    logger.warn(
      { agent: deps.agent_name, error: err instanceof Error ? err.message : String(err) },
      "Summarising the conversation failed; continuing with it as it was",
    );
    return undefined;
  }
}
