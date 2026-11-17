import type { BudgetConfig } from "@tuttiai/types";
import { logger } from "./logger.js";

/**
 * Per-million USD pricing for known models.
 *
 * Re-exported from `@tuttiai/core` so downstream packages (notably
 * `@tuttiai/router`) can estimate cost without duplicating the table.
 * Add new entries here whenever a provider ships a new model.
 */
export const PRICING: Record<string, { input: number; output: number }> = {
  "claude-sonnet-5-5": { input: 2.0, output: 10.0 },
  "claude-sonnet-5": { input: 2.0, output: 10.0 },
  "claude-sonnet-4-6": { input: 3.0, output: 15.0 },
  "claude-opus-4-7": { input: 5.0, output: 25.0 },
  "claude-opus-4-6": { input: 5.0, output: 25.0 },
  // retired 2026-06-15; kept so older scores are still costed
  "claude-sonnet-4-20250514": { input: 3.0, output: 15.0 },
  "claude-opus-4-20250514": { input: 15.0, output: 75.0 },
  "claude-haiku-4-5-20251001": { input: 1.0, output: 5.0 },
  "claude-haiku-4-5": { input: 1.0, output: 5.0 },
  "gpt-4o": { input: 2.5, output: 10.0 },
  "gemini-2.0-flash": { input: 0.1, output: 0.4 },
};

const UNKNOWN_MODEL_WARNING =
  "TokenBudget: no PRICING entry for this model; its tokens are costed at $0 or at the budget model's rate, so max_cost_usd may not be enforced";

/** Model ids already warned about, so each unknown id is logged once per process. */
const warnedModels = new Set<string>();

/**
 * Look up the rates for one model id.
 *
 * `Object.hasOwn` keeps prototype keys (`__proto__`, `constructor`,
 * `toString` and the like) out of the lookup, so they are unknown models
 * rather than inherited values. The first lookup of each unknown id logs
 * one warning carrying only the id.
 */
function priceFor(model: string): { input: number; output: number } | undefined {
  if (Object.hasOwn(PRICING, model)) {
    // eslint-disable-next-line security/detect-object-injection -- ownership-checked above
    return PRICING[model];
  }
  if (!warnedModels.has(model)) {
    warnedModels.add(model);
    logger.warn({ model }, UNKNOWN_MODEL_WARNING);
  }
  return undefined;
}

export class TokenBudget {
  private used_input = 0;
  private used_output = 0;
  /** Cost for tokens accumulated via `add()` calls that supplied a
   *  `model_override`. Kept separately so the constructor model still
   *  prices any unmodelled tokens. */
  private override_cost_usd = 0;
  private override_input = 0;
  private override_output = 0;

  constructor(
    private config: BudgetConfig,
    private model: string,
  ) {}

  /**
   * Accumulate tokens for one LLM call.
   *
   * @param input_tokens - Prompt tokens consumed.
   * @param output_tokens - Completion tokens generated.
   * @param model_override - The model the call actually ran on. Optional
   *   override used by `AgentConfig.model === 'auto'` runs where the
   *   per-call model is decided by a `SmartProvider` and differs from
   *   the `TokenBudget`'s construction-time model. When supplied with a
   *   known price, this call's cost is priced at the override rate;
   *   otherwise it falls back to the constructor model, and the first
   *   such id logs a single process-wide warning.
   */
  add(input_tokens: number, output_tokens: number, model_override?: string): void {
    this.used_input += input_tokens;
    this.used_output += output_tokens;
    if (model_override !== undefined && model_override !== "") {
      const prices = priceFor(model_override);
      if (prices) {
        this.override_cost_usd +=
          (input_tokens / 1_000_000) * prices.input +
          (output_tokens / 1_000_000) * prices.output;
        this.override_input += input_tokens;
        this.override_output += output_tokens;
      }
    }
  }

  get total_tokens(): number {
    return this.used_input + this.used_output;
  }

  /**
   * Estimated USD cost of every token added so far.
   *
   * Tokens not priced by a `model_override` are priced at the constructor
   * model's rate, or at $0 when that model has no `PRICING` entry. The
   * first time an unknown constructor model has tokens to price, a single
   * process-wide warning names it.
   */
  get estimated_cost_usd(): number {
    // Tokens covered by a per-call override are already priced;
    // remaining tokens fall back to the construction-time model.
    const remainingIn = this.used_input - this.override_input;
    const remainingOut = this.used_output - this.override_output;
    if (remainingIn + remainingOut === 0) return this.override_cost_usd;
    const prices = priceFor(this.model);
    const baseCost = prices
      ? (remainingIn / 1_000_000) * prices.input +
        (remainingOut / 1_000_000) * prices.output
      : 0;
    return this.override_cost_usd + baseCost;
  }

  /**
   * Decide whether a future call with the given projected cost would
   * push the cumulative `estimated_cost_usd` over `max_cost_usd`.
   *
   * Returns `true` when no `max_cost_usd` ceiling is configured — the
   * caller has no budget to violate. Used by `AgentRunner`'s router
   * integration to demote a request to a cheaper tier before dispatch
   * rather than waiting for `check()` to flip to `"exceeded"` after the
   * fact.
   *
   * @param estimated_cost_usd - Projected USD cost of the upcoming call.
   */
  canAfford(estimated_cost_usd: number): boolean {
    if (!this.config.max_cost_usd) return true;
    return this.estimated_cost_usd + estimated_cost_usd <= this.config.max_cost_usd;
  }

  check(): "ok" | "warning" | "exceeded" {
    const warnAt = this.config.warn_at_percent ?? 80;
    if (this.config.max_tokens) {
      const pct = (this.total_tokens / this.config.max_tokens) * 100;
      if (pct >= 100) return "exceeded";
      if (pct >= warnAt) return "warning";
    }
    if (this.config.max_cost_usd) {
      const pct = (this.estimated_cost_usd / this.config.max_cost_usd) * 100;
      if (pct >= 100) return "exceeded";
      if (pct >= warnAt) return "warning";
    }
    return "ok";
  }

  summary(): string {
    return (
      "Tokens: " +
      this.total_tokens.toLocaleString() +
      " | Est. cost: $" +
      this.estimated_cost_usd.toFixed(4)
    );
  }
}
