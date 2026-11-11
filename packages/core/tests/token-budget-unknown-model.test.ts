import { beforeEach, describe, expect, it, vi } from "vitest";

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));

vi.mock("../src/logger.js", () => ({ logger: { warn } }));

import { PRICING, TokenBudget } from "../src/token-budget.js";

const MESSAGE =
  "TokenBudget: no PRICING entry for this model; its tokens are costed at $0 or at the budget model's rate, so max_cost_usd may not be enforced";

// The warned-ids set lives for the whole process, so every test that
// counts warnings uses a model id no other test uses.
function warningsFor(model: string): number {
  return warn.mock.calls.filter(([fields]) => {
    const logged: unknown = fields;
    if (typeof logged !== "object" || logged === null) return false;
    return Object.is(Reflect.get(logged, "model"), model);
  }).length;
}

describe("TokenBudget with a model PRICING does not list", () => {
  beforeEach(() => {
    warn.mockClear();
  });

  it("does not warn for a known model", () => {
    const budget = new TokenBudget({ max_cost_usd: 100 }, "claude-sonnet-4-6");
    budget.add(1_000_000, 1_000_000);
    expect(budget.estimated_cost_usd).toBeCloseTo(18.0);
    expect(budget.check()).toBe("ok");
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns once for an unknown constructor model across calls and instances", () => {
    const model = "unknown-ctor-once";
    const first = new TokenBudget({ max_cost_usd: 1 }, model);
    first.add(100, 50);
    first.check();
    first.summary();
    const second = new TokenBudget({ max_cost_usd: 1 }, model);
    second.add(10, 5);
    expect(second.canAfford(0.5)).toBe(true);
    expect(second.summary()).toContain("$0.0000");
    expect(warningsFor(model)).toBe(1);
  });

  it("warns separately for a second unknown model", () => {
    const first = new TokenBudget({}, "unknown-pair-a");
    first.add(1, 1);
    expect(first.estimated_cost_usd).toBe(0);
    const other = new TokenBudget({}, "unknown-pair-b");
    other.add(1, 1);
    expect(other.estimated_cost_usd).toBe(0);
    expect(warningsFor("unknown-pair-a")).toBe(1);
    expect(warningsFor("unknown-pair-b")).toBe(1);
  });

  it("logs only the model id and the fixed message", () => {
    const budget = new TokenBudget({ max_cost_usd: 5, max_tokens: 10 }, "unknown-args");
    budget.add(3, 4);
    expect(budget.estimated_cost_usd).toBe(0);
    expect(warn.mock.calls).toEqual([[{ model: "unknown-args" }, MESSAGE]]);
  });

  it("warns once for an unknown model_override and costs it at the constructor rate", () => {
    const budget = new TokenBudget({}, "claude-opus-4-7");
    budget.add(1_000_000, 0, "unknown-override");
    budget.add(0, 1_000_000, "unknown-override");
    expect(budget.estimated_cost_usd).toBeCloseTo(30.0);
    expect(warningsFor("unknown-override")).toBe(1);
    expect(warningsFor("claude-opus-4-7")).toBe(0);
  });

  it("does not warn for an unknown constructor model while overrides price every token", () => {
    const budget = new TokenBudget({}, "unknown-auto");
    budget.add(1_000_000, 1_000_000, "claude-sonnet-5-5");
    expect(budget.estimated_cost_usd).toBeCloseTo(12.0);
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not warn before an unknown model has any tokens to price", () => {
    const budget = new TokenBudget({ max_cost_usd: 1 }, "unknown-empty");
    expect(budget.estimated_cost_usd).toBe(0);
    expect(budget.check()).toBe("ok");
    expect(warn).not.toHaveBeenCalled();
  });
});

describe.each(["__proto__", "constructor", "toString", "hasOwnProperty"])(
  "TokenBudget with the prototype key %s",
  (key) => {
    it("has no own PRICING entry for it", () => {
      expect(Object.hasOwn(PRICING, key)).toBe(false);
    });

    it("costs it as an unknown constructor model at $0, not NaN", () => {
      const budget = new TokenBudget({ max_cost_usd: 1 }, key);
      budget.add(1_000, 1_000);
      expect(budget.estimated_cost_usd).toBe(0);
      expect(budget.canAfford(0.5)).toBe(true);
      expect(budget.check()).toBe("ok");
      expect(budget.summary()).toBe("Tokens: 2,000 | Est. cost: $0.0000");
      expect(warn).toHaveBeenCalledWith({ model: key }, MESSAGE);
    });

    it("costs it as an override at the constructor model's rate", () => {
      const budget = new TokenBudget({ max_cost_usd: 12 }, "claude-sonnet-5-5");
      budget.add(1_000_000, 1_000_000, key);
      expect(budget.estimated_cost_usd).toBeCloseTo(12.0);
      expect(budget.check()).toBe("exceeded");
    });
  },
);
