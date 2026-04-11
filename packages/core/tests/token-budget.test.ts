import { describe, it, expect, vi } from "vitest";
import { TokenBudget } from "../src/token-budget.js";
import { AgentRunner } from "../src/agent-runner.js";
import { EventBus } from "../src/event-bus.js";
import { InMemorySessionStore } from "../src/session-store.js";
import {
  createMockProvider,
  textResponse,
  toolUseResponse,
  simpleAgent,
} from "./helpers/mock-provider.js";
import type { TuttiEvent } from "@tuttiai/types";

describe("TokenBudget", () => {
  describe("add() and total_tokens", () => {
    it("accumulates input and output tokens", () => {
      const budget = new TokenBudget({ max_tokens: 1000 }, "gpt-4o");
      budget.add(100, 50);
      expect(budget.total_tokens).toBe(150);
      budget.add(200, 100);
      expect(budget.total_tokens).toBe(450);
    });
  });

  describe("estimated_cost_usd", () => {
    it("calculates cost for a known model", () => {
      const budget = new TokenBudget({}, "claude-sonnet-4-20250514");
      budget.add(1_000_000, 1_000_000);
      // input: 1M * $3/M = $3, output: 1M * $15/M = $15 → $18
      expect(budget.estimated_cost_usd).toBeCloseTo(18.0);
    });

    it("calculates cost for gpt-4o", () => {
      const budget = new TokenBudget({}, "gpt-4o");
      budget.add(1_000_000, 1_000_000);
      // input: 1M * $2.5/M = $2.5, output: 1M * $10/M = $10 → $12.5
      expect(budget.estimated_cost_usd).toBeCloseTo(12.5);
    });

    it("calculates cost for gemini-2.0-flash", () => {
      const budget = new TokenBudget({}, "gemini-2.0-flash");
      budget.add(1_000_000, 1_000_000);
      // input: 1M * $0.1/M = $0.1, output: 1M * $0.4/M = $0.4 → $0.5
      expect(budget.estimated_cost_usd).toBeCloseTo(0.5);
    });

    it("returns 0 for an unknown model", () => {
      const budget = new TokenBudget({}, "unknown-model");
      budget.add(1_000_000, 1_000_000);
      expect(budget.estimated_cost_usd).toBe(0);
    });
  });

  describe("check()", () => {
    it("returns 'ok' when under budget", () => {
      const budget = new TokenBudget({ max_tokens: 1000 }, "gpt-4o");
      budget.add(10, 5);
      expect(budget.check()).toBe("ok");
    });

    it("returns 'warning' at default 80% of token limit", () => {
      const budget = new TokenBudget({ max_tokens: 100 }, "gpt-4o");
      budget.add(50, 35);
      expect(budget.check()).toBe("warning");
    });

    it("returns 'exceeded' at 100% of token limit", () => {
      const budget = new TokenBudget({ max_tokens: 100 }, "gpt-4o");
      budget.add(60, 40);
      expect(budget.check()).toBe("exceeded");
    });

    it("returns 'warning' at custom warn_at_percent", () => {
      const budget = new TokenBudget(
        { max_tokens: 100, warn_at_percent: 50 },
        "gpt-4o",
      );
      budget.add(30, 25);
      expect(budget.check()).toBe("warning");
    });

    it("returns 'warning' based on cost limit", () => {
      const budget = new TokenBudget(
        { max_cost_usd: 0.01 },
        "claude-sonnet-4-20250514",
      );
      // Need enough tokens to hit 80% of $0.01
      // $0.01 * 0.8 = $0.008
      // input cost at $3/M: need 2667 tokens for $0.008
      budget.add(3000, 0);
      expect(budget.check()).toBe("warning");
    });

    it("returns 'exceeded' based on cost limit", () => {
      const budget = new TokenBudget(
        { max_cost_usd: 0.01 },
        "claude-sonnet-4-20250514",
      );
      // $0.01 at $3/M input = ~3334 tokens
      budget.add(4000, 0);
      expect(budget.check()).toBe("exceeded");
    });

    it("returns 'ok' when no limits set", () => {
      const budget = new TokenBudget({}, "gpt-4o");
      budget.add(999_999, 999_999);
      expect(budget.check()).toBe("ok");
    });
  });

  describe("summary()", () => {
    it("formats tokens and cost", () => {
      const budget = new TokenBudget({}, "gpt-4o");
      budget.add(1000, 500);
      const s = budget.summary();
      expect(s).toContain("1,500");
      expect(s).toContain("$");
    });
  });
});

describe("AgentRunner budget integration", () => {
  it("emits budget:warning when token budget hits warn threshold", async () => {
    const provider = createMockProvider([textResponse("Hello!")]);
    const events = new EventBus();
    const sessions = new InMemorySessionStore();
    const runner = new AgentRunner(provider, events, sessions);

    const emitted: TuttiEvent[] = [];
    events.onAny((e) => emitted.push(e));

    await runner.run(
      {
        ...simpleAgent,
        budget: { max_tokens: 100, warn_at_percent: 50 },
      },
      "Hi",
    );

    // Mock provider returns 10 input + 5 output = 15 tokens per response
    // 15/100 = 15% — below 50% threshold, so no warning
    const warnings = emitted.filter((e) => e.type === "budget:warning");
    expect(warnings).toHaveLength(0);
  });

  it("emits budget:warning when usage exceeds warn threshold", async () => {
    // Custom response with high token usage
    const provider = createMockProvider([
      {
        id: "r1",
        content: [{ type: "text", text: "done" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 60, output_tokens: 30 },
      },
    ]);
    const events = new EventBus();
    const sessions = new InMemorySessionStore();
    const runner = new AgentRunner(provider, events, sessions);

    const emitted: TuttiEvent[] = [];
    events.onAny((e) => emitted.push(e));

    await runner.run(
      {
        ...simpleAgent,
        budget: { max_tokens: 100, warn_at_percent: 50 },
      },
      "Hi",
    );

    // 60 + 30 = 90 tokens, 90% of 100 → warning
    const warnings = emitted.filter((e) => e.type === "budget:warning");
    expect(warnings).toHaveLength(1);
  });

  it("emits budget:exceeded and stops the loop", async () => {
    const provider = createMockProvider([
      {
        id: "r1",
        content: [
          { type: "tool_use", id: "t1", name: "noop", input: {} },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 80, output_tokens: 30 },
      },
      // This response should never be reached
      textResponse("should not get here"),
    ]);
    const events = new EventBus();
    const sessions = new InMemorySessionStore();
    const runner = new AgentRunner(provider, events, sessions);

    const emitted: TuttiEvent[] = [];
    events.onAny((e) => emitted.push(e));

    const result = await runner.run(
      {
        ...simpleAgent,
        budget: { max_tokens: 100 },
      },
      "Hi",
    );

    const exceeded = emitted.filter((e) => e.type === "budget:exceeded");
    expect(exceeded).toHaveLength(1);
    // Should have stopped after 1 turn
    expect(result.turns).toBe(1);
    // Second provider call should not have been made
    expect(provider.chat).toHaveBeenCalledTimes(1);
  });
});
