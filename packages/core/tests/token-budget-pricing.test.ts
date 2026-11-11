import { describe, it, expect } from "vitest";
import { PRICING, TokenBudget } from "../src/token-budget.js";

// Figures from https://platform.claude.com/docs/en/about-claude/pricing,
// read 2026-11-05 and again 2026-11-11: Claude Sonnet 5.5 is $2 input and
// $10 output per 1M tokens.
describe("PRICING for claude-sonnet-5-5", () => {
  it("has a claude-sonnet-5-5 row of the same shape as the others", () => {
    expect(PRICING["claude-sonnet-5-5"]).toEqual({ input: 2.0, output: 10.0 });
  });

  it("costs 1M input and 1M output tokens on claude-sonnet-5-5 at $2 + $10", () => {
    const budget = new TokenBudget({}, "claude-sonnet-5-5");
    budget.add(1_000_000, 1_000_000);
    expect(budget.estimated_cost_usd).toBeCloseTo(12.0);
  });

  it("still costs the retired claude-sonnet-4-20250514 at $3 + $15", () => {
    const budget = new TokenBudget({}, "claude-sonnet-4-20250514");
    budget.add(1_000_000, 1_000_000);
    expect(budget.estimated_cost_usd).toBeCloseTo(18.0);
  });

  it("prices a claude-sonnet-5-5 model_override on a budget built with an unknown model", () => {
    const budget = new TokenBudget({}, "unknown-model");
    budget.add(1_000_000, 1_000_000, "claude-sonnet-5-5");
    expect(budget.estimated_cost_usd).toBeCloseTo(12.0);
  });

  it("stops a max_cost_usd budget on claude-sonnet-5-5 once the cost reaches it", () => {
    const budget = new TokenBudget({ max_cost_usd: 12 }, "claude-sonnet-5-5");
    budget.add(1_000_000, 1_000_000);
    expect(budget.check()).toBe("exceeded");
  });
});

// Figures from https://platform.claude.com/docs/en/about-claude/pricing,
// read 2026-11-11, per 1M tokens (input + output).
describe.each([
  { model: "claude-sonnet-5", input: 2.0, output: 10.0 },
  { model: "claude-sonnet-4-6", input: 3.0, output: 15.0 },
  { model: "claude-opus-4-7", input: 5.0, output: 25.0 },
  { model: "claude-opus-4-6", input: 5.0, output: 25.0 },
])("PRICING for $model", ({ model, input, output }) => {
  it("has an own row at the published rate", () => {
    expect(Object.hasOwn(PRICING, model)).toBe(true);
    expect(PRICING[model]).toEqual({ input, output });
  });

  it("costs 1M input and 1M output tokens at that rate", () => {
    const budget = new TokenBudget({}, model);
    budget.add(1_000_000, 1_000_000);
    expect(budget.estimated_cost_usd).toBeCloseTo(input + output);
  });

  it("prices it as a model_override on a budget built with another model", () => {
    const budget = new TokenBudget({}, "claude-haiku-4-5");
    budget.add(1_000_000, 1_000_000, model);
    expect(budget.estimated_cost_usd).toBeCloseTo(input + output);
  });

  it("stops a max_cost_usd budget once the cost reaches it", () => {
    const budget = new TokenBudget({ max_cost_usd: input + output }, model);
    budget.add(1_000_000, 1_000_000);
    expect(budget.check()).toBe("exceeded");
  });
});
