import { afterEach, describe, expect, it, vi } from "vitest";

import { budgetFor, CarriedTokenBudget, validCost } from "../../src/interrupt/carried-budget.js";
import type { PausedTurn } from "../../src/interrupt/pause.js";
import { logger } from "../../src/logger.js";
import { TokenBudget } from "../../src/token-budget.js";

// claude-haiku-4-5: $1 in, $5 out per million; gpt-4o: $2.50 in, $10 out.
const MODEL = "claude-haiku-4-5";

function pausedTurn(usage: PausedTurn["usage"]): PausedTurn {
  return {
    session_id: "s1",
    turn: 1,
    messages: [],
    response: { id: "", content: [], stop_reason: "tool_use", usage: { input_tokens: 0, output_tokens: 0 } },
    dispositions: new Map(),
    usage,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("validCost", () => {
  it.each([0, 0.2, 12])("accepts %s", (v) => {
    expect(validCost(v)).toBe(v);
  });

  it.each([-1, -0.0001, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, null, undefined, "0.1", {}])(
    "rejects %s",
    (v) => {
      expect(validCost(v)).toBeUndefined();
    },
  );
});

describe("CarriedTokenBudget", () => {
  it("adds the carried cost to the priced tokens", () => {
    const budget = new CarriedTokenBudget({ max_cost_usd: 1 }, MODEL, 0.2);
    budget.add(100_000, 10_000);
    expect(budget.estimated_cost_usd).toBeCloseTo(0.35, 10);
  });

  it("adds the carried cost to tokens priced with a model override", () => {
    const budget = new CarriedTokenBudget({ max_cost_usd: 1 }, MODEL, 0.2);
    budget.add(100_000, 10_000, "gpt-4o");
    expect(budget.estimated_cost_usd).toBeCloseTo(0.55, 10);
  });

  it("reports exceeded and refuses a call because of the carried cost alone", () => {
    const budget = new CarriedTokenBudget({ max_cost_usd: 0.3 }, MODEL, 0.3);
    expect(budget.check()).toBe("exceeded");
    expect(budget.canAfford(0.01)).toBe(false);
  });

  it("warns once the carried cost reaches the warning threshold", () => {
    expect(new CarriedTokenBudget({ max_cost_usd: 1 }, MODEL, 0.85).check()).toBe("warning");
  });

  it("includes the carried cost in the summary", () => {
    expect(new CarriedTokenBudget({ max_cost_usd: 1 }, MODEL, 0.2).summary()).toBe("Tokens: 0 | Est. cost: $0.2000");
  });

  it("behaves as a plain budget with a carried cost of zero", () => {
    const carried = new CarriedTokenBudget({ max_cost_usd: 0.3 }, MODEL, 0);
    const plain = new TokenBudget({ max_cost_usd: 0.3 }, MODEL);
    carried.add(100_000, 20_000);
    plain.add(100_000, 20_000);
    expect(carried.estimated_cost_usd).toBe(plain.estimated_cost_usd);
    expect(carried.check()).toBe(plain.check());
    expect(carried.canAfford(0.05)).toBe(plain.canAfford(0.05));
  });
});

describe("budgetFor", () => {
  it("gives no budget when the agent has none, even for a paused turn", () => {
    expect(budgetFor(undefined, MODEL)).toBeUndefined();
    expect(budgetFor(undefined, MODEL, pausedTurn({ input_tokens: 1, output_tokens: 1, cost_usd: 0.2 }))).toBeUndefined();
  });

  it("gives a plain budget for a fresh run, without logging", () => {
    const debug = vi.spyOn(logger, "debug");
    const budget = budgetFor({ max_cost_usd: 1 }, MODEL);
    expect(budget).toBeInstanceOf(TokenBudget);
    expect(budget).not.toBeInstanceOf(CarriedTokenBudget);
    expect(debug).not.toHaveBeenCalled();
  });

  it("carries a paused turn's saved cost", () => {
    const budget = budgetFor({ max_cost_usd: 1 }, MODEL, pausedTurn({ input_tokens: 1, output_tokens: 1, cost_usd: 0.2 }));
    expect(budget).toBeInstanceOf(CarriedTokenBudget);
    expect(budget?.estimated_cost_usd).toBe(0.2);
    expect(budget?.total_tokens).toBe(0);
  });

  it("counts from zero with one debug log, naming only the session, when the paused turn kept no cost", () => {
    const debug = vi.spyOn(logger, "debug");
    const budget = budgetFor({ max_cost_usd: 1 }, MODEL, pausedTurn({ input_tokens: 1, output_tokens: 1 }));
    expect(budget).not.toBeInstanceOf(CarriedTokenBudget);
    expect(budget?.estimated_cost_usd).toBe(0);
    expect(debug).toHaveBeenCalledTimes(1);
    expect(debug).toHaveBeenCalledWith({ session: "s1" }, expect.stringContaining("no saved cost"));
  });
});
