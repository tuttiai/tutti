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

  constructor(
    private config: BudgetConfig,
    private model: string,
  ) {}

  add(input_tokens: number, output_tokens: number): void {
    this.used_input += input_tokens;
    this.used_output += output_tokens;
  }

  get total_tokens(): number {
    return this.used_input + this.used_output;
  }

  get estimated_cost_usd(): number {
    const prices = PRICING[this.model];
    if (!prices) return 0;
    return (
      (this.used_input / 1_000_000) * prices.input +
      (this.used_output / 1_000_000) * prices.output
    );
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
