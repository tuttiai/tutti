import type { TokenUsage } from "@tuttiai/types";

/**
 * Add one call's token usage into a running total, in place. The cache
 * figures are carried only once some call has reported them, so a total from
 * a provider that never reports caching keeps its original shape.
 *
 * @param total - The running total, mutated.
 * @param usage - The usage to add.
 *
 * @example
 * const total: TokenUsage = { input_tokens: 0, output_tokens: 0 };
 * addUsage(total, response.usage);
 */
export function addUsage(total: TokenUsage, usage: TokenUsage): void {
  total.input_tokens += usage.input_tokens;
  total.output_tokens += usage.output_tokens;
  if (usage.cache_read_input_tokens !== undefined) {
    total.cache_read_input_tokens = (total.cache_read_input_tokens ?? 0) + usage.cache_read_input_tokens;
  }
  if (usage.cache_creation_input_tokens !== undefined) {
    total.cache_creation_input_tokens = (total.cache_creation_input_tokens ?? 0) + usage.cache_creation_input_tokens;
  }
}
