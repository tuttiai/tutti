/**
 * `model: 'auto'` agent-level sentinel tests.
 *
 * `auto` opts a single agent into per-call routing via the score's
 * `SmartProvider`. These tests cover the runner-side adapter:
 * validation when no SmartProvider is configured, span attribution of
 * the resolved model, per-call pricing for cost budgets, and mixed-mode
 * scores where one agent uses `auto` and another runs on a fixed model.
 *
 * We use a hand-rolled fake here for the same reason
 * `agent-runner-router.test.ts` does — `@tuttiai/core` must not depend
 * on `@tuttiai/router`. The fake mirrors `SmartProvider`'s observable
 * contract (the `name === 'smart-router'` marker, `chat`,
 * `previewDecision`, `getLastDecision`).
 */
import { describe, expect, it } from "vitest";
import type {
  AgentConfig,
  ChatRequest,
  ChatResponse,
  LLMProvider,
  StreamChunk,
  TuttiEvent,
} from "@tuttiai/types";
import type { TuttiSpan } from "@tuttiai/telemetry";
import { AgentRunner } from "../src/agent-runner.js";
import { EventBus } from "../src/event-bus.js";
import { InMemorySessionStore } from "../src/session-store.js";
import { getTuttiTracer } from "../src/telemetry.js";
import { TuttiRuntime } from "../src/runtime.js";
import { BudgetExceededError } from "../src/errors.js";
import { createMockProvider, simpleAgent, textResponse } from "./helpers/mock-provider.js";

interface FakeOptions {
  /** Model the fake reports as having picked for each call. */
  pickedModel: string;
  /** Tier label echoed back on the decision callback. */
  tier?: string;
  /** Override pickedModel mid-run (e.g. one tier per call). */
  perCallModels?: string[];
  /** Usage values returned by `chat`. Defaults to a small fixed payload. */
  usage?: { input_tokens: number; output_tokens: number };
}

class FakeSmartProvider implements LLMProvider {
  readonly name = "smart-router";
  config: {
    on_decision?: (d: {
      tier: string;
      model: string;
      reason: string;
      classifier: string;
      estimated_input_tokens: number;
      estimated_cost_usd: number;
    }) => void;
    on_fallback?: (i: { from_model: string; to_model: string; error: string }) => void;
  } = {};

  private callIndex = 0;
  private lastModel = "";

  constructor(private opts: FakeOptions) {
    this.lastModel = opts.pickedModel;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async previewDecision(): Promise<{ estimated_cost_usd: number }> {
    return { estimated_cost_usd: 0 };
  }

  async chat(_req: ChatRequest): Promise<ChatResponse> {
    const model =
      this.opts.perCallModels?.[this.callIndex] ?? this.opts.pickedModel;
    this.lastModel = model;
    this.callIndex++;
    // Fire on_decision so the runner's mirror onto llm.completion span
    // populates `router_*` attrs the way the real SmartProvider does.
    await Promise.resolve();
    this.config.on_decision?.({
      tier: this.opts.tier ?? "small",
      model,
      reason: "classified",
      classifier: "heuristic",
      estimated_input_tokens: 10,
      estimated_cost_usd: 0,
    });
    const usage = this.opts.usage ?? { input_tokens: 10, output_tokens: 5 };
    return {
      id: `r-${this.callIndex}`,
      content: [{ type: "text", text: `from ${model}` }],
      stop_reason: "end_turn",
      usage,
    };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async *stream(): AsyncGenerator<StreamChunk> {
    // Unused — present to satisfy LLMProvider.
  }

  getLastDecision(): { model: string } | undefined {
    return { model: this.lastModel };
  }
}

const autoAgent: AgentConfig = {
  ...simpleAgent,
  model: "auto",
};

describe("model: 'auto' validation", () => {
  it("throws at run start when the provider is not a SmartProvider", async () => {
    // Plain mock provider has no `name === 'smart-router'` marker.
    const plain = createMockProvider([textResponse("never returned")]);
    const events = new EventBus();
    const runner = new AgentRunner(plain, events, new InMemorySessionStore());

    await expect(runner.run(autoAgent, "hi")).rejects.toThrow(
      /model: 'auto'.*SmartProvider/i,
    );
    expect(plain.chat).not.toHaveBeenCalled();
  });

  it("works when a SmartProvider is wired on the score", async () => {
    const provider = new FakeSmartProvider({ pickedModel: "claude-haiku-3-5" });
    const events = new EventBus();
    const runner = new AgentRunner(provider, events, new InMemorySessionStore());

    const result = await runner.run(autoAgent, "hi");
    expect(result.output).toBe("from claude-haiku-3-5");
  });
});

describe("model: 'auto' span attribution", () => {
  it("marks llm.completion spans with auto_routed=true and the resolved model", async () => {
    const provider = new FakeSmartProvider({
      pickedModel: "claude-haiku-3-5",
      tier: "small",
    });
    const events = new EventBus();
    const closed: TuttiSpan[] = [];
    const unsubscribe = getTuttiTracer().subscribe((s) => {
      if (s.status !== "running") closed.push(s);
    });

    try {
      const runner = new AgentRunner(provider, events, new InMemorySessionStore());
      await runner.run(autoAgent, "hi");
    } finally {
      unsubscribe();
    }

    const llmSpan = closed.find((s) => s.name === "llm.completion");
    expect(llmSpan, "expected an llm.completion span").toBeDefined();
    expect(llmSpan?.attributes.auto_routed).toBe(true);
    expect(llmSpan?.attributes.model).toBe("claude-haiku-3-5");
    // Existing router_* attrs still get mirrored from on_decision.
    expect(llmSpan?.attributes.router_tier).toBe("small");
    expect(llmSpan?.attributes.router_model).toBe("claude-haiku-3-5");
  });

  it("does NOT set auto_routed for fixed-model agents driven by the same SmartProvider", async () => {
    const provider = new FakeSmartProvider({ pickedModel: "claude-haiku-3-5" });
    const events = new EventBus();
    const closed: TuttiSpan[] = [];
    const unsubscribe = getTuttiTracer().subscribe((s) => {
      if (s.status !== "running") closed.push(s);
    });

    const fixed: AgentConfig = { ...simpleAgent, model: "claude-sonnet-4-20250514" };

    try {
      const runner = new AgentRunner(provider, events, new InMemorySessionStore());
      await runner.run(fixed, "hi");
    } finally {
      unsubscribe();
    }

    const llmSpan = closed.find((s) => s.name === "llm.completion");
    expect(llmSpan?.attributes.auto_routed).toBeUndefined();
  });
});

describe("model: 'auto' budget integration", () => {
  it("prices each call at the SmartProvider's chosen tier (not 'auto')", async () => {
    // claude-sonnet-4-20250514: $3 / $15 per 1M.
    // 2000 input × 3/1M + 500 output × 15/1M = $0.0135 — over the $0.01 cap.
    const provider = new FakeSmartProvider({
      pickedModel: "claude-sonnet-4-20250514",
      usage: { input_tokens: 2000, output_tokens: 500 },
    });

    const score = {
      provider,
      agents: {
        assistant: {
          ...autoAgent,
          name: "assistant",
          budget: { max_cost_usd: 0.01 },
        },
      },
    };
    const runtime = new TuttiRuntime(score);

    let caught: BudgetExceededError | undefined;
    try {
      await runtime.run("assistant", "hi");
    } catch (err) {
      if (err instanceof BudgetExceededError) caught = err;
    }
    expect(caught, "expected per-run budget breach").toBeDefined();
    expect(caught!.scope).toBe("run");
    expect(caught!.current).toBeGreaterThanOrEqual(0.01);
  });

  it("does not breach when the resolved tier fits inside the cap", async () => {
    // claude-haiku-3-5: $0.80 / $4 per 1M — same usage costs $0.0036, well under.
    const provider = new FakeSmartProvider({
      pickedModel: "claude-haiku-3-5",
      usage: { input_tokens: 2000, output_tokens: 500 },
    });

    const score = {
      provider,
      agents: {
        assistant: {
          ...autoAgent,
          name: "assistant",
          budget: { max_cost_usd: 0.01 },
        },
      },
    };
    const runtime = new TuttiRuntime(score);

    const result = await runtime.run("assistant", "hi");
    expect(result.output).toBe("from claude-haiku-3-5");
  });
});

describe("Mixed-mode score (auto + fixed agents)", () => {
  it("lets one agent use 'auto' while another stays on a fixed model", async () => {
    const provider = new FakeSmartProvider({ pickedModel: "claude-haiku-3-5" });
    const score = {
      provider,
      agents: {
        triage: { ...autoAgent, name: "triage" },
        evaluator: {
          ...simpleAgent,
          name: "evaluator",
          model: "claude-opus-4",
        },
      },
    };
    const runtime = new TuttiRuntime(score);

    const events: TuttiEvent[] = [];
    runtime.events.onAny((e) => events.push(e));

    const triageResult = await runtime.run("triage", "classify this");
    const evalResult = await runtime.run("evaluator", "rate that");

    // Both runs went through the SmartProvider; both succeeded.
    expect(triageResult.output).toBe("from claude-haiku-3-5");
    expect(evalResult.output).toBe("from claude-haiku-3-5");
    // Each run produced exactly one llm:response.
    const responses = events.filter((e) => e.type === "llm:response");
    expect(responses).toHaveLength(2);
  });
});
