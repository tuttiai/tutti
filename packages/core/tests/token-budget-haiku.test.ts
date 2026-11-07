import { describe, it, expect } from "vitest";
import { PRICING, TokenBudget } from "../src/token-budget.js";
import { DEFAULT_SKILL_EXECUTOR_MODEL } from "../src/skills/executor.js";
import { DEFAULT_PROPOSER_MODEL } from "../src/skills/proposer.js";

const HAIKU_DATED = "claude-haiku-4-5-20251001";
const HAIKU_ALIAS = "claude-haiku-4-5";

describe("TokenBudget pricing for Claude Haiku 4.5", () => {
  it("prices the dated id at $1 input and $5 output per million tokens", () => {
    const budget = new TokenBudget({}, HAIKU_DATED);
    budget.add(1_000_000, 1_000_000);
    expect(budget.estimated_cost_usd).toBeCloseTo(6.0);
  });

  it("prices the alias at the same rate as the dated id", () => {
    const budget = new TokenBudget({}, HAIKU_ALIAS);
    budget.add(1_000_000, 1_000_000);
    expect(budget.estimated_cost_usd).toBeCloseTo(6.0);
    expect(PRICING[HAIKU_ALIAS]).toEqual(PRICING[HAIKU_DATED]);
  });

  it("prices a Haiku 4.5 model_override on a budget built with an unknown model", () => {
    const budget = new TokenBudget({}, "unknown-model");
    budget.add(1_000_000, 1_000_000, HAIKU_ALIAS);
    expect(budget.estimated_cost_usd).toBeCloseTo(6.0);
  });

  it("reports exceeded when Haiku 4.5 usage passes max_cost_usd", () => {
    const budget = new TokenBudget({ max_cost_usd: 0.01 }, HAIKU_ALIAS);
    // 10k input at $1/M = $0.01, 10k output at $5/M = $0.05, so $0.06
    budget.add(10_000, 10_000);
    expect(budget.check()).toBe("exceeded");
  });

  it("prices the skill default models, so their budgets are not $0", () => {
    expect(Object.hasOwn(PRICING, DEFAULT_SKILL_EXECUTOR_MODEL)).toBe(true);
    expect(Object.hasOwn(PRICING, DEFAULT_PROPOSER_MODEL)).toBe(true);
  });

  it("treats the non-existent claude-haiku-4-20250514 id as an unknown model", () => {
    const budget = new TokenBudget({}, "claude-haiku-4-20250514");
    budget.add(1_000_000, 1_000_000);
    expect(Object.hasOwn(PRICING, "claude-haiku-4-20250514")).toBe(false);
    expect(budget.estimated_cost_usd).toBe(0);
  });
});
