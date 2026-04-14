import type { TokenUsage } from "@tuttiai/types";

/**
 * Sonnet-class fallback pricing (USD per million tokens).
 *
 * Matches the constants in `packages/core/src/agent-router.ts`.
 * Callers needing strict per-model pricing should use {@link TokenBudget}
 * from `@tuttiai/core` instead.
 */
const DEFAULT_INPUT_PER_M = 3;
const DEFAULT_OUTPUT_PER_M = 15;

/**
 * Rough cost estimate for a single run.
 *
 * @param usage - Aggregated token counts from the agent result.
 * @returns Estimated cost in USD using Sonnet-class pricing.
 */
export function estimateCostUsd(usage: TokenUsage): number {
  return (
    (usage.input_tokens / 1_000_000) * DEFAULT_INPUT_PER_M +
    (usage.output_tokens / 1_000_000) * DEFAULT_OUTPUT_PER_M
  );
}
