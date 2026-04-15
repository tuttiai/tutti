import { getTuttiTracer, type TuttiTracer } from "./tracer.js";
import type { SpanStatus, TuttiSpan } from "./types.js";

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

/**
 * One row in a "recent traces" listing. Captures the data needed to
 * render a single line of the `tutti-ai traces list` table without
 * shipping every span over the wire.
 *
 * `started_at` is an ISO-8601 string (not a `Date`) so the type round-trips
 * cleanly through JSON without callers having to revive dates.
 */
export interface TraceSummary {
  trace_id: string;
  /** Agent that produced the trace, when the root span recorded it. */
  agent_id?: string;
  /** ISO-8601 timestamp of the root span. */
  started_at: string;
  /** Duration of the root span. `null` while the run is still in flight. */
  duration_ms: number | null;
  /** Status of the root span — drives the colour in the CLI table. */
  status: SpanStatus;
  /** Sum of `total_tokens` across every `llm.completion` span in the trace. */
  total_tokens: number;
  /**
   * Aggregated USD cost. `null` only when no `llm.completion` span had a
   * known cost — see {@link getRunCost} for the same semantics.
   */
  cost_usd: number | null;
}

/**
 * Group spans by `trace_id`, derive a per-trace summary from the root
 * span, and return the most-recent-first list trimmed to `limit`.
 *
 * Traces with no root span (every span in the group has a parent that is
 * absent from the input) are skipped — they're partial fragments left
 * over from ring-buffer eviction and have no meaningful start time.
 *
 * @param spans - Raw spans, typically from {@link TuttiTracer.getAllSpans}.
 * @param limit - Maximum number of summaries to return. Defaults to 20.
 */
export function buildTraceSummaries(
  spans: readonly TuttiSpan[],
  limit = 20,
): TraceSummary[] {
  const groups = new Map<string, TuttiSpan[]>();
  for (const span of spans) {
    const arr = groups.get(span.trace_id) ?? [];
    arr.push(span);
    groups.set(span.trace_id, arr);
  }

  const summaries: TraceSummary[] = [];
  for (const [trace_id, traceSpans] of groups) {
    // The root is the only span in the group with no parent. If eviction
    // dropped it we cannot build a meaningful summary — skip silently.
    const root = traceSpans.find((s) => s.parent_span_id === undefined);
    if (!root) continue;

    let total_tokens = 0;
    let cost_usd = 0;
    let anyCost = false;
    for (const s of traceSpans) {
      if (s.name !== "llm.completion") continue;
      total_tokens += s.attributes.total_tokens ?? 0;
      if (s.attributes.cost_usd !== undefined) {
        cost_usd += s.attributes.cost_usd;
        anyCost = true;
      }
    }

    summaries.push({
      trace_id,
      ...(root.attributes.agent_id !== undefined
        ? { agent_id: root.attributes.agent_id }
        : {}),
      started_at: root.started_at.toISOString(),
      duration_ms: root.duration_ms ?? null,
      status: root.status,
      total_tokens,
      cost_usd: anyCost ? cost_usd : null,
    });
  }

  // Most recent first — ISO-8601 strings sort lexicographically.
  summaries.sort((a, b) => (a.started_at < b.started_at ? 1 : -1));
  return summaries.slice(0, limit);
}
