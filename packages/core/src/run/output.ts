/**
 * Final-output resolution: extract the run's text, and — when the agent
 * declares an `outputSchema` — coerce it into that schema, re-prompting the
 * model on each failure.
 */

import type { AgentConfig, ChatMessage, ChatRequest, ChatResponse, TokenUsage } from "@tuttiai/types";
import { StructuredOutputError } from "../errors.js";
import { logger } from "../logger.js";
import { extractText } from "./helpers.js";

/** Default number of repair attempts before giving up on an `outputSchema`. */
export const DEFAULT_STRUCTURED_OUTPUT_MAX_RETRIES = 3;

/** Mutable turn counter, shared with the caller so repair turns are counted. */
export interface OutputTurnCounter {
  /** Turns consumed so far. Incremented once per repair attempt. */
  turns: number;
}

/** Collaborators {@link resolveRunOutput} needs from the runner. */
export interface OutputContext {
  /** The run's message list. Repair prompts and responses are appended here. */
  messages: ChatMessage[];
  /** The system prompt each repair request is sent with. */
  baseSystemPrompt: string;
  /** The run's usage accumulator, incremented by each repair call. */
  totalUsage: TokenUsage;
  /**
   * Issue one model call. The caller supplies this already wrapped in its
   * provider-retry policy and pointed at either the streaming or the
   * non-streaming path, per the agent's `streaming` flag.
   */
  callModel: (request: ChatRequest) => Promise<ChatResponse>;
}

/** The run's resolved output. */
export interface ResolvedRunOutput {
  /** The final assistant text. */
  output: string;
  /** The parsed value when an `outputSchema` is set, otherwise `undefined`. */
  structuredResult: unknown;
}

/**
 * Extract the final assistant text from a message list.
 *
 * @param messages - The run's messages.
 * @returns The text of the last assistant message, or `""`.
 */
export function extractFinalOutput(messages: ChatMessage[]): string {
  return extractText(messages.filter((m) => m.role === "assistant").at(-1)?.content);
}

/**
 * Resolve the run's output, repairing it against the agent's `outputSchema`.
 *
 * When the agent declares no schema the initial output is returned unchanged.
 * Otherwise the output is parsed as JSON and validated; on failure the error is
 * fed back to the model as a user turn and the call is retried, up to the
 * agent's `maxRetries`.
 *
 * `ctx.messages`, `ctx.totalUsage` and `counter` are mutated in place, exactly
 * as the inline implementation did — a repair attempt is a real turn and is
 * accounted for as one.
 *
 * @param agent - The agent that produced the output.
 * @param initialOutput - The text extracted from the final assistant message.
 * @param ctx - The message list, prompt, usage accumulator and model callback.
 * @param counter - The run's turn counter, incremented per repair attempt.
 * @returns The final output and the parsed structured result.
 * @throws {StructuredOutputError} When the output still fails to validate after the last retry.
 */
export async function resolveRunOutput(
  agent: AgentConfig,
  initialOutput: string,
  ctx: OutputContext,
  counter: OutputTurnCounter,
): Promise<ResolvedRunOutput> {
  let output = initialOutput;
  let structuredResult: unknown = undefined;

  if (!agent.outputSchema) return { output, structuredResult };

  const maxRetries = agent.maxRetries ?? DEFAULT_STRUCTURED_OUTPUT_MAX_RETRIES;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const parsed: unknown = JSON.parse(output);
      structuredResult = agent.outputSchema.parse(parsed);
      break;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);

      if (attempt >= maxRetries) {
        throw new StructuredOutputError(output, errorMsg);
      }

      logger.warn(
        { agent: agent.name, attempt: attempt + 1, error: errorMsg },
        "Structured output validation failed, retrying",
      );

      ctx.messages.push({
        role: "user",
        content: `Your response was invalid JSON. Error: ${errorMsg}. Try again.`,
      });

      counter.turns++;

      const retryRequest: ChatRequest = {
        model: agent.model,
        system: ctx.baseSystemPrompt,
        messages: ctx.messages,
      };

      const retryResponse = await ctx.callModel(retryRequest);

      ctx.totalUsage.input_tokens += retryResponse.usage.input_tokens;
      ctx.totalUsage.output_tokens += retryResponse.usage.output_tokens;
      ctx.messages.push({ role: "assistant", content: retryResponse.content });

      output = extractText(retryResponse.content);
    }
  }

  return { output, structuredResult };
}
