import { getTuttiTracer, type TuttiTracer } from "./tracer.js";

/**
 * Per-million-token USD pricing for one model. Both rates are quoted on
 * the same denominator so {@link estimateCost} can divide once at the end.
 */
export interface ModelPrice {
  /** USD per 1,000,000 input (prompt) tokens. */
  input: number;
  /** USD per 1,000,000 output (completion) tokens. */
  output: number;
}

/**
 * Built-in price table. Prices are USD per 1M tokens and reflect publicly
 * listed rates as of the package release. Override or extend with
 * {@link registerModelPrice}.
 *
 * Exposed for inspection (e.g. building a UI of supported models).
 * Mutating it directly is unsupported — use {@link registerModelPrice}.
 */
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = Object.freeze({
  "gpt-4o": { input: 5, output: 15 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "claude-opus-4": { input: 15, output: 75 },
  "claude-sonnet-4": { input: 3, output: 15 },
  "claude-haiku-3-5": { input: 0.8, output: 4 },
  "gemini-2-0-flash": { input: 0.1, output: 0.4 },
});

// Working table — seeded from the frozen defaults, mutated by
// registerModelPrice. Kept private so callers can't bypass validation.
const PRICES = new Map<string, ModelPrice>(Object.entries(MODEL_PRICES));

/**
 * Register or override the price for a model. Use this to add custom or
 * fine-tuned models, or to update the built-in rates after a price change.
 *
 * @param model - The exact model identifier the runtime emits (matches
 *   the `model` attribute on `llm.completion` spans).
 * @param inputPer1M - USD per 1M input/prompt tokens. Must be `>= 0`.
 * @param outputPer1M - USD per 1M output/completion tokens. Must be `>= 0`.
 * @throws {Error} When either rate is negative or non-finite.
 */
export function registerModelPrice(
  model: string,
  inputPer1M: number,
  outputPer1M: number,
): void {
  if (!Number.isFinite(inputPer1M) || inputPer1M < 0) {
    throw new Error(
      `registerModelPrice: inputPer1M must be a non-negative finite number, got ${String(inputPer1M)}`,
    );
  }
  if (!Number.isFinite(outputPer1M) || outputPer1M < 0) {
    throw new Error(
      `registerModelPrice: outputPer1M must be a non-negative finite number, got ${String(outputPer1M)}`,
    );
  }
  PRICES.set(model, { input: inputPer1M, output: outputPer1M });
}

/**
 * Estimate the USD cost of a single LLM call for a known model. Returns
 * `null` when the model is not in the price table — callers can fall back
 * to a heuristic or surface "unknown" rather than silently zero-cost.
 *
 * @example
 * estimateCost("gpt-4o", 1000, 500); // 0.0125
 * estimateCost("unknown-model", 1000, 500); // null
 */
export function estimateCost(
  model: string,
  promptTokens: number,
  completionTokens: number,
): number | null {
  const price = PRICES.get(model);
  if (!price) return null;
  return (
    (promptTokens * price.input + completionTokens * price.output) / 1_000_000
  );
}

/**
 * Aggregate cost + token totals for a single agent run.
 *
 * `cost_usd` is `null` when no `llm.completion` span in the trace had a
 * known cost (e.g. every span used an unregistered model). When at least
 * one span has a cost, the sum of the *known* costs is returned — the
 * total may be partial if the run mixed registered and unregistered
 * models. Inspect individual spans via `tracer.getTrace(traceId)` to
 * disambiguate.
 */
export interface RunCost {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost_usd: number | null;
}

/**
 * Sum every `llm.completion` span belonging to one trace and return the
 * aggregate token + cost figures.
 *
 * Reads from the {@link getTuttiTracer} singleton by default, so it
 * naturally pairs with the runtime's automatic instrumentation. Pass a
 * custom tracer to aggregate from an isolated test instance.
 */
export function getRunCost(traceId: string, tracer: TuttiTracer = getTuttiTracer()): RunCost {
  const spans = tracer.getTrace(traceId);

  let prompt_tokens = 0;
  let completion_tokens = 0;
  let total_tokens = 0;
  let cost_usd = 0;
  let anyCost = false;

  for (const span of spans) {
    if (span.name !== "llm.completion") continue;
    const a = span.attributes;
    prompt_tokens += a.prompt_tokens ?? 0;
    completion_tokens += a.completion_tokens ?? 0;
    total_tokens += a.total_tokens ?? 0;
    if (a.cost_usd !== undefined) {
      cost_usd += a.cost_usd;
      anyCost = true;
    }
  }

  return {
    prompt_tokens,
    completion_tokens,
    total_tokens,
    cost_usd: anyCost ? cost_usd : null,
  };
}
