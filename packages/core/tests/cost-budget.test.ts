/**
 * Cost-budget enforcement tests for the agent runtime.
 *
 * Covers per-run, daily, and monthly cost ceilings — the warning event
 * at the configured threshold, the hard `BudgetExceededError` throw on
 * breach, and snapshot-driven daily/monthly aggregation through a
 * `RunCostStore`.
 *
 * Uses claude-sonnet-4-20250514 ($3 / $15 per 1M tokens) as the test
 * model — its prices are baked into `TokenBudget`, so the runner can
 * compute deterministic per-call costs without a real provider.
 */
import { describe, it, expect } from "vitest";
import { TuttiRuntime } from "../src/runtime.js";
import { BudgetExceededError } from "../src/errors.js";
import { InMemoryRunCostStore } from "@tuttiai/telemetry";
import { createMockProvider } from "./helpers/mock-provider.js";
import type { ScoreConfig, TuttiEvent, ChatResponse } from "@tuttiai/types";

const TEST_MODEL = "claude-sonnet-4-20250514"; // $3 / $15 per 1M
// One response that costs $0.0135: 2000 input × 3/1M + 500 output × 15/1M.
function bigResponse(): ChatResponse {
  return {
    id: "r-big",
    content: [{ type: "text", text: "done" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 2000, output_tokens: 500 },
  };
}

// $0.00675: 1000 input × 3/1M + 250 output × 15/1M. About 67% of $0.01.
function mediumResponse(): ChatResponse {
  return {
    id: "r-med",
    content: [{ type: "text", text: "ok" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 1000, output_tokens: 250 },
  };
}

function makeScore(provider: ScoreConfig["provider"], budget: NonNullable<ScoreConfig["agents"][string]["budget"]>): ScoreConfig {
  return {
    provider,
    agents: {
      assistant: {
        name: "assistant",
        model: TEST_MODEL,
        system_prompt: "You are a helpful assistant.",
        voices: [],
        budget,
        max_turns: 5,
      },
    },
  };
}

describe("Per-run cost budget", () => {
  it("throws BudgetExceededError with scope='run' when accumulated cost exceeds max_cost_usd", async () => {
    const provider = createMockProvider([bigResponse()]);
    const score = makeScore(provider, { max_cost_usd: 0.01 });
    const runtime = new TuttiRuntime(score);

    await expect(runtime.run("assistant", "hello")).rejects.toBeInstanceOf(
      BudgetExceededError,
    );
  });

  it("throw carries scope, limit, and current as structured fields", async () => {
    const provider = createMockProvider([bigResponse()]);
    const score = makeScore(provider, { max_cost_usd: 0.01 });
    const runtime = new TuttiRuntime(score);

    let caught: BudgetExceededError | undefined;
    try {
      await runtime.run("assistant", "hello");
    } catch (err) {
      if (err instanceof BudgetExceededError) caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught!.scope).toBe("run");
    expect(caught!.limit).toBe(0.01);
    expect(caught!.current).toBeGreaterThanOrEqual(0.01);
  });

  it("emits budget:warning at the warn_at_percent threshold but does not throw", async () => {
    // First response costs ~$0.00675 (67% of $0.01). Default warn_at = 80% — no warning.
    // Second response adds $0.003 (1000 input × 3/1M) → cumulative ~$0.00975 (97.5%) → warning, not exceeded.
    const second: ChatResponse = {
      id: "r-bump",
      content: [{ type: "text", text: "still here" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1000, output_tokens: 0 },
    };
    const provider = createMockProvider([
      { ...mediumResponse(), stop_reason: "tool_use" as const, content: [{ type: "tool_use", id: "t1", name: "noop", input: {} }] } as ChatResponse,
      second,
    ]);
    // No actual tool — but max_tool_calls keeps the run going without error
    // path; a tool_use without a matching tool would fail. Instead, drive
    // the loop with two end_turn responses by using a very low budget on
    // the agent that allows the second turn.
    void provider;
    // Restart with simpler shape: both responses end_turn; we drive two
    // turns by making the LLM ask for input — easier: use a single
    // response shaped to push us into the warn band.
    const oneShot = createMockProvider([
      // ~$0.009 = 1000 × 3/1M + 400 × 15/1M = 0.003 + 0.006 = 0.009 (90% of $0.01).
      {
        id: "r-warn",
        content: [{ type: "text", text: "hi" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1000, output_tokens: 400 },
      } as ChatResponse,
    ]);
    const score = makeScore(oneShot, { max_cost_usd: 0.01 });
    const runtime = new TuttiRuntime(score);
    const events: TuttiEvent[] = [];
    runtime.events.onAny((e) => events.push(e));

    await runtime.run("assistant", "hello");

    const warnings = events.filter((e) => e.type === "budget:warning");
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(warnings[0]).toMatchObject({ scope: "run", limit: 0.01 });
    const exceeded = events.filter((e) => e.type === "budget:exceeded");
    expect(exceeded.length).toBe(0);
  });

  it("does not enforce when budget is absent", async () => {
    const provider = createMockProvider([bigResponse()]);
    const score: ScoreConfig = {
      provider,
      agents: {
        assistant: {
          name: "assistant",
          model: TEST_MODEL,
          system_prompt: "You are a helpful assistant.",
          voices: [],
        },
      },
    };
    const runtime = new TuttiRuntime(score);
    const result = await runtime.run("assistant", "hello");
    expect(result.output).toBe("done");
  });
});

describe("Daily cost budget", () => {
  it("throws on first turn when the snapshot already exceeds the daily limit", async () => {
    // Pre-seed the store so the snapshot at run start is over the cap.
    const store = new InMemoryRunCostStore();
    await store.record({
      run_id: "earlier-today",
      agent_name: "assistant",
      started_at: new Date(),
      cost_usd: 1.0,
      total_tokens: 100_000,
    });

    const provider = createMockProvider([mediumResponse()]);
    const score = makeScore(provider, { max_cost_usd_per_day: 0.5 });
    const runtime = new TuttiRuntime(score, { runCostStore: store });

    let caught: BudgetExceededError | undefined;
    try {
      await runtime.run("assistant", "hello");
    } catch (err) {
      if (err instanceof BudgetExceededError) caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught!.scope).toBe("day");
    expect(caught!.limit).toBe(0.5);
    expect(caught!.current).toBeCloseTo(1.0, 5);
    // Hard pre-call: provider must not have been called.
    expect(provider.chat).not.toHaveBeenCalled();
  });

  it("throws after the call when this run's cost pushes the total past the daily cap", async () => {
    const store = new InMemoryRunCostStore();
    // Snapshot at $0.495 — close to the $0.5 cap but not over.
    await store.record({
      run_id: "earlier-today",
      agent_name: "assistant",
      started_at: new Date(),
      cost_usd: 0.495,
      total_tokens: 1000,
    });

    // Single response costs $0.0135 — total = $0.5085 > $0.5.
    const provider = createMockProvider([bigResponse()]);
    const score = makeScore(provider, { max_cost_usd_per_day: 0.5 });
    const runtime = new TuttiRuntime(score, { runCostStore: store });

    let caught: BudgetExceededError | undefined;
    try {
      await runtime.run("assistant", "hello");
    } catch (err) {
      if (err instanceof BudgetExceededError) caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught!.scope).toBe("day");
    expect(provider.chat).toHaveBeenCalledTimes(1);
  });

  it("records this run's cost in the store on success", async () => {
    const store = new InMemoryRunCostStore();
    const provider = createMockProvider([mediumResponse()]); // $0.00675
    const score = makeScore(provider, { max_cost_usd_per_day: 1.0 });
    const runtime = new TuttiRuntime(score, { runCostStore: store });

    await runtime.run("assistant", "hello");

    const total = await store.sumSince(new Date(0));
    // Cost recorded by the runner uses the trace's getRunCost when
    // available, which returns null for unknown models — but
    // claude-sonnet-4-20250514 is in the local TokenBudget pricing, so
    // the budget's estimated_cost_usd is the fallback. Allow either
    // path: the sum must be > 0 to prove the runner wrote something.
    expect(total).toBeGreaterThan(0);
  });
});

describe("Monthly cost budget", () => {
  it("throws when monthly snapshot is over the limit", async () => {
    const store = new InMemoryRunCostStore();
    await store.record({
      run_id: "earlier-this-month",
      agent_name: "assistant",
      started_at: new Date(),
      cost_usd: 100.0,
      total_tokens: 10_000_000,
    });

    const provider = createMockProvider([mediumResponse()]);
    const score = makeScore(provider, { max_cost_usd_per_month: 50.0 });
    const runtime = new TuttiRuntime(score, { runCostStore: store });

    let caught: BudgetExceededError | undefined;
    try {
      await runtime.run("assistant", "hello");
    } catch (err) {
      if (err instanceof BudgetExceededError) caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught!.scope).toBe("month");
    expect(caught!.limit).toBe(50.0);
  });

  it("emits budget:warning with scope='month' at the 80% threshold", async () => {
    const store = new InMemoryRunCostStore();
    // 85% of $1.0 → triggers warning, not breach.
    await store.record({
      run_id: "previous",
      agent_name: "assistant",
      started_at: new Date(),
      cost_usd: 0.85,
      total_tokens: 1000,
    });

    const provider = createMockProvider([mediumResponse()]); // adds ~$0.00675
    const score = makeScore(provider, { max_cost_usd_per_month: 1.0 });
    const runtime = new TuttiRuntime(score, { runCostStore: store });
    const events: TuttiEvent[] = [];
    runtime.events.onAny((e) => events.push(e));

    await runtime.run("assistant", "hello");

    const monthWarnings = events.filter(
      (e) => e.type === "budget:warning" && e.scope === "month",
    );
    expect(monthWarnings.length).toBeGreaterThanOrEqual(1);
    expect(monthWarnings[0]).toMatchObject({ scope: "month", limit: 1.0 });
  });
});

describe("RunCostStore is optional", () => {
  it("daily/monthly limits are silently skipped when no store is configured", async () => {
    // Even with a daily limit set, no store → no enforcement. The run
    // should complete normally.
    const provider = createMockProvider([mediumResponse()]);
    const score = makeScore(provider, { max_cost_usd_per_day: 0.0001 });
    const runtime = new TuttiRuntime(score); // no runCostStore

    const result = await runtime.run("assistant", "hello");
    expect(result.output).toBe("ok");
  });
});
