import type { AgentContextConfig, ChatMessage, ChatRequest, ChatResponse } from "@tuttiai/types";

import { logger } from "../logger.js";
import { summariseHistory, summaryCut } from "./summarise.js";
import { estimateTokens, trimToolResults } from "./trim.js";

const DEFAULT_KEEP_RECENT_TOOL_RESULTS = 4;
const DEFAULT_TRIMMED_CHARS = 400;
const DEFAULT_KEEP_RECENT_MESSAGES = 8;

/*
 * How far a conversation must grow past its last shortening before it is
 * shortened again, as a share of the threshold. Every rewrite of the history
 * breaks the Claude Code session that holds it, so the next call re-sends and
 * re-caches the whole conversation (ADR-0026). Shortening in steps keeps the
 * calls in between on the resumed session.
 */
const STEP_SHARE = 0.25;

/** The estimated size of each live conversation just after it was last trimmed, and last summarised. */
const trimmedAt = new WeakMap<ChatMessage[], number>();
const summarisedAt = new WeakMap<ChatMessage[], number>();

/**
 * Whether a conversation over `threshold` has grown enough since its last
 * shortening of this kind to be shortened again.
 */
function due(tokens: number, threshold: number, last: number | undefined): boolean {
  if (tokens <= threshold) return false;
  return last === undefined || tokens - last >= Math.max(1, Math.floor(threshold * STEP_SHARE));
}

/** What compacting a conversation needs from the runner. */
export interface CompactDeps {
  /** The agent, for logs. */
  agent_name: string;
  /** Sends one request to the agent's model, counted against the run's budget. */
  chat: (request: Omit<ChatRequest, "model">) => Promise<ChatResponse>;
}

/**
 * Trim older tool results until the conversation is a step below `threshold`,
 * keeping fewer recent results whole when the usual number would leave it
 * over: a trim that leaves it over the threshold would be repeated on the very
 * next turn. The most recent result is always kept whole.
 */
function trimToLowWater(messages: ChatMessage[], threshold: number, keep_recent: number, keep_chars: number): number {
  const lowWater = threshold * (1 - STEP_SHARE);
  let removed = 0;
  for (let keep = Math.max(1, keep_recent); keep >= 1; keep--) {
    removed += trimToolResults(messages, keep, keep_chars);
    if (estimateTokens(messages) <= lowWater) break;
  }
  return removed;
}

/**
 * Shorten a conversation before a model call, per the agent's `context`
 * settings, in place: first older tool results, then, if it is still too
 * large, the older part of the conversation is summarised. A failed summary
 * is logged and the run carries on with the conversation as it was.
 *
 * Once a conversation has been shortened, it is left alone until it has grown
 * by a quarter of the threshold again, so most calls send an unchanged history
 * and resume their provider session instead of starting a new one.
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
  if (
    config.trim_after_tokens !== undefined &&
    due(estimateTokens(messages), config.trim_after_tokens, trimmedAt.get(messages))
  ) {
    const removed = trimToLowWater(
      messages,
      config.trim_after_tokens,
      config.keep_recent_tool_results ?? DEFAULT_KEEP_RECENT_TOOL_RESULTS,
      config.trimmed_tool_result_chars ?? DEFAULT_TRIMMED_CHARS,
    );
    trimmedAt.set(messages, estimateTokens(messages));
    if (removed > 0) logger.info({ agent: deps.agent_name, chars_removed: removed }, "Shortened older tool results");
  }
  if (config.summarise_after_tokens === undefined) return undefined;
  const before = estimateTokens(messages);
  if (!due(before, config.summarise_after_tokens, summarisedAt.get(messages))) return undefined;
  const cut = summaryCut(messages, config.keep_recent_messages ?? DEFAULT_KEEP_RECENT_MESSAGES);
  if (cut === undefined) return undefined;
  try {
    const response = await summariseHistory(messages, cut, deps.chat);
    summarisedAt.set(messages, estimateTokens(messages));
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
