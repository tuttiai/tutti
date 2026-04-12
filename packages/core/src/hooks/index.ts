/**
 * Built-in hook factories for common patterns.
 */

import type { TuttiHooks, HookContext, ChatRequest, ChatResponse } from "@tuttiai/types";
import type { ToolResult } from "@tuttiai/types";
import type pino from "pino";

/**
 * Logs all LLM calls and tool executions via a pino logger.
 */
export function createLoggingHook(log: pino.Logger): TuttiHooks {
  return {
    async beforeLLMCall(ctx: HookContext, request: ChatRequest): Promise<ChatRequest> {
      log.info({ agent: ctx.agent_name, turn: ctx.turn, model: request.model }, "LLM call");
      return request;
    },
    async afterLLMCall(ctx: HookContext, response: ChatResponse): Promise<void> {
      log.info({ agent: ctx.agent_name, turn: ctx.turn, usage: response.usage }, "LLM response");
    },
    async beforeToolCall(ctx: HookContext, tool: string, input: unknown): Promise<unknown> {
      log.info({ agent: ctx.agent_name, tool, input }, "Tool call");
      return input;
    },
    async afterToolCall(ctx: HookContext, tool: string, result: ToolResult): Promise<ToolResult> {
      log.info({ agent: ctx.agent_name, tool, is_error: result.is_error }, "Tool result");
      return result;
    },
  };
}

/**
 * Caches tool results by tool name + input hash.
 * The `store` is a simple Map or any get/set interface.
 */
export function createCacheHook(
  store: { get(key: string): string | undefined; set(key: string, value: string): void },
): TuttiHooks {
  function cacheKey(tool: string, input: unknown): string {
    return tool + ":" + JSON.stringify(input);
  }
  return {
    async beforeToolCall(_ctx: HookContext, tool: string, input: unknown): Promise<boolean | unknown> {
      const cached = store.get(cacheKey(tool, input));
      if (cached) return cached;
      return input;
    },
    async afterToolCall(_ctx: HookContext, tool: string, result: ToolResult): Promise<ToolResult> {
      if (!result.is_error) {
        store.set(cacheKey(tool, result.content), result.content);
      }
      return result;
    },
  };
}

/**
 * Blocks specific tool names from being called.
 */
export function createBlocklistHook(blockedTools: string[]): TuttiHooks {
  const blocked = new Set(blockedTools);
  return {
    async beforeToolCall(_ctx: HookContext, tool: string): Promise<boolean> {
      return !blocked.has(tool);
    },
  };
}

/**
 * Blocks LLM calls once estimated cost exceeds the given USD limit.
 * Tracks cost across the lifetime of the hook instance.
 */
export function createMaxCostHook(maxUsd: number): TuttiHooks {
  let totalCost = 0;
  // Default Sonnet-class pricing per million tokens
  const INPUT_PER_M = 3;
  const OUTPUT_PER_M = 15;

  return {
    async afterLLMCall(_ctx: HookContext, response: ChatResponse): Promise<void> {
      totalCost +=
        (response.usage.input_tokens / 1_000_000) * INPUT_PER_M +
        (response.usage.output_tokens / 1_000_000) * OUTPUT_PER_M;
    },
    async beforeLLMCall(ctx: HookContext, request: ChatRequest): Promise<ChatRequest> {
      if (totalCost >= maxUsd) {
        throw new Error(
          "Max cost hook: $" + totalCost.toFixed(4) + " exceeds limit $" + maxUsd.toFixed(2) +
          " for agent " + ctx.agent_name,
        );
      }
      return request;
    },
  };
}
