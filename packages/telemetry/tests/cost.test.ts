import { describe, it, expect } from "vitest";

import {
  MODEL_PRICES,
  estimateCost,
  getRunCost,
  registerModelPrice,
} from "../src/cost.js";
import { TuttiTracer, getTuttiTracer } from "../src/tracer.js";

describe("estimateCost", () => {
  it("computes USD cost for built-in models with known token counts", () => {
    // gpt-4o: $5 / 1M input, $15 / 1M output
    // 1000 input × 5/1M = 0.005, 500 output × 15/1M = 0.0075 → 0.0125
    expect(estimateCost("gpt-4o", 1000, 500)).toBeCloseTo(0.0125, 10);

    // claude-opus-4: $15 / $75 — 200 in, 100 out → 0.003 + 0.0075 = 0.0105
    expect(estimateCost("claude-opus-4", 200, 100)).toBeCloseTo(0.0105, 10);

    // claude-haiku-3-5: $0.80 / $4 — 1M in, 1M out → 0.80 + 4.00 = 4.80
    expect(estimateCost("claude-haiku-3-5", 1_000_000, 1_000_000)).toBeCloseTo(
      4.8,
      10,
    );

    // gemini-2-0-flash: $0.10 / $0.40 — 0 in, 0 out → 0
    expect(estimateCost("gemini-2-0-flash", 0, 0)).toBe(0);
  });

  it("returns null for unknown models so callers can detect missing pricing", () => {
    expect(estimateCost("not-a-real-model", 1000, 500)).toBeNull();
    expect(estimateCost("", 1, 1)).toBeNull();
  });

  it("scales linearly with token counts", () => {
    const single = estimateCost("gpt-4o-mini", 1000, 1000);
    const double = estimateCost("gpt-4o-mini", 2000, 2000);
    expect(single).not.toBeNull();
    expect(double).not.toBeNull();
    expect(double!).toBeCloseTo(single! * 2, 12);
  });
});

describe("registerModelPrice", () => {
  it("makes a custom model resolvable by estimateCost", () => {
    expect(estimateCost("test-custom-model-1", 1000, 500)).toBeNull();

    registerModelPrice("test-custom-model-1", 10, 30);

    // 1000 × 10/1M + 500 × 30/1M = 0.01 + 0.015 = 0.025
    expect(estimateCost("test-custom-model-1", 1000, 500)).toBeCloseTo(
      0.025,
      10,
    );
  });

  it("overrides built-in prices", () => {
    const before = estimateCost("gpt-4o", 1000, 0);
    registerModelPrice("gpt-4o", 100, 200);
    const after = estimateCost("gpt-4o", 1000, 0);
    expect(after).not.toBe(before);
    expect(after).toBeCloseTo(0.1, 10);
    // Restore so other tests in this run see the original price.
    registerModelPrice("gpt-4o", MODEL_PRICES["gpt-4o"]!.input, MODEL_PRICES["gpt-4o"]!.output);
  });

  it("rejects negative or non-finite prices", () => {
    expect(() => registerModelPrice("bad-1", -1, 10)).toThrow(/non-negative/);
    expect(() => registerModelPrice("bad-2", 10, -1)).toThrow(/non-negative/);
    expect(() => registerModelPrice("bad-3", Number.NaN, 10)).toThrow(
      /non-negative/,
    );
    expect(() => registerModelPrice("bad-4", 10, Number.POSITIVE_INFINITY)).toThrow(
      /non-negative/,
    );
  });

  it("accepts zero (free / self-hosted models)", () => {
    registerModelPrice("test-free-model", 0, 0);
    expect(estimateCost("test-free-model", 100_000, 50_000)).toBe(0);
  });
});

describe("MODEL_PRICES", () => {
  it("includes all six required built-in models with documented rates", () => {
    expect(MODEL_PRICES["gpt-4o"]).toEqual({ input: 5, output: 15 });
    expect(MODEL_PRICES["gpt-4o-mini"]).toEqual({ input: 0.15, output: 0.6 });
    expect(MODEL_PRICES["claude-opus-4"]).toEqual({ input: 15, output: 75 });
    expect(MODEL_PRICES["claude-sonnet-4"]).toEqual({ input: 3, output: 15 });
    expect(MODEL_PRICES["claude-haiku-3-5"]).toEqual({ input: 0.8, output: 4 });
    expect(MODEL_PRICES["gemini-2-0-flash"]).toEqual({ input: 0.1, output: 0.4 });
  });

  it("is frozen so consumers cannot mutate prices behind registerModelPrice's back", () => {
    expect(Object.isFrozen(MODEL_PRICES)).toBe(true);
  });
});

describe("getRunCost", () => {
  it("aggregates token counts and cost across every llm.completion span in a trace", () => {
    const tracer = new TuttiTracer();

    const root = tracer.startSpan("agent.run", "agent");
    const llm1 = tracer.startSpan("llm.completion", "llm", { model: "gpt-4o" }, root.span_id);
    tracer.endSpan(llm1.span_id, "ok", {
      prompt_tokens: 1000,
      completion_tokens: 500,
      total_tokens: 1500,
      cost_usd: 0.0125,
    });
    const llm2 = tracer.startSpan("llm.completion", "llm", { model: "gpt-4o" }, root.span_id);
    tracer.endSpan(llm2.span_id, "ok", {
      prompt_tokens: 2000,
      completion_tokens: 1000,
      total_tokens: 3000,
      cost_usd: 0.025,
    });
    tracer.endSpan(root.span_id, "ok");

    const cost = getRunCost(root.trace_id, tracer);
    expect(cost.prompt_tokens).toBe(3000);
    expect(cost.completion_tokens).toBe(1500);
    expect(cost.total_tokens).toBe(4500);
    expect(cost.cost_usd).toBeCloseTo(0.0375, 10);
  });

  it("ignores non-llm spans in the same trace", () => {
    const tracer = new TuttiTracer();
    const root = tracer.startSpan("agent.run", "agent");
    const tool = tracer.startSpan("tool.call", "tool", { tool_name: "noop" }, root.span_id);
    tracer.endSpan(tool.span_id, "ok");
    const llm = tracer.startSpan("llm.completion", "llm", { model: "gpt-4o" }, root.span_id);
    tracer.endSpan(llm.span_id, "ok", {
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
      cost_usd: 0.001,
    });
    tracer.endSpan(root.span_id, "ok");

    const cost = getRunCost(root.trace_id, tracer);
    expect(cost.total_tokens).toBe(150); // tool span did not contribute
    expect(cost.cost_usd).toBeCloseTo(0.001, 10);
  });

  it("returns null cost when no llm.completion span has a known cost", () => {
    const tracer = new TuttiTracer();
    const root = tracer.startSpan("agent.run", "agent");
    const llm = tracer.startSpan(
      "llm.completion",
      "llm",
      { model: "unregistered-model" },
      root.span_id,
    );
    tracer.endSpan(llm.span_id, "ok", {
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
    });
    tracer.endSpan(root.span_id, "ok");

    const cost = getRunCost(root.trace_id, tracer);
    expect(cost.prompt_tokens).toBe(100);
    expect(cost.completion_tokens).toBe(50);
    expect(cost.total_tokens).toBe(150);
    expect(cost.cost_usd).toBeNull();
  });

  it("returns zeros and null for an unknown trace id", () => {
    const tracer = new TuttiTracer();
    const cost = getRunCost("trace-that-does-not-exist", tracer);
    expect(cost).toEqual({
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      cost_usd: null,
    });
  });

  it("defaults to the singleton tracer when no tracer is passed", () => {
    const singleton = getTuttiTracer();
    const root = singleton.startSpan("agent.run", "agent");
    const llm = singleton.startSpan(
      "llm.completion",
      "llm",
      { model: "gpt-4o" },
      root.span_id,
    );
    singleton.endSpan(llm.span_id, "ok", {
      prompt_tokens: 100,
      completion_tokens: 100,
      total_tokens: 200,
      cost_usd: 0.002,
    });
    singleton.endSpan(root.span_id, "ok");

    const cost = getRunCost(root.trace_id);
    expect(cost.cost_usd).toBeCloseTo(0.002, 10);
  });
});

describe("getTuttiTracer singleton", () => {
  it("returns the same instance across calls", () => {
    expect(getTuttiTracer()).toBe(getTuttiTracer());
  });
});
