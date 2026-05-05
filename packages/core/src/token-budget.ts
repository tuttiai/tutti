import type { BudgetConfig } from "@tuttiai/types";

/**
 * Per-million USD pricing for known models.
 *
 * Re-exported from `@tuttiai/core` so downstream packages (notably
 * `@tuttiai/router`) can estimate cost without duplicating the table.
 * Add new entries here whenever a provider ships a new model.
 */
export const PRICING: Record<string, { input: number; output: number }> = {
  "claude-sonnet-4-20250514": { input: 3.0, output: 15.0 },
  "claude-opus-4-20250514": { input: 15.0, output: 75.0 },
  "claude-haiku-4-20250514": { input: 0.25, output: 1.25 },
  "gpt-4o": { input: 2.5, output: 10.0 },
  "gemini-2.0-flash": { input: 0.1, output: 0.4 },
};

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
   *   otherwise it falls back to the constructor model.
   */
  add(input_tokens: number, output_tokens: number, model_override?: string): void {
    this.used_input += input_tokens;
    this.used_output += output_tokens;
    if (model_override !== undefined && model_override !== "") {
      // `Object.hasOwn` keeps prototype keys (`__proto__` etc.) out of
      // the lookup — `model_override` originates from the SmartProvider's
      // last decision and is not user input, but defence in depth costs
      // nothing here.
      const prices = Object.hasOwn(PRICING, model_override)
        ? // eslint-disable-next-line security/detect-object-injection -- ownership-checked above
          PRICING[model_override]
        : undefined;
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

  get estimated_cost_usd(): number {
    // Tokens covered by a per-call override are already priced;
    // remaining tokens fall back to the construction-time model.
    const remainingIn = this.used_input - this.override_input;
    const remainingOut = this.used_output - this.override_output;
    const prices = PRICING[this.model];
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
