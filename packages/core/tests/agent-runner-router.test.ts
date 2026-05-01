/**
 * AgentRunner ↔ @tuttiai/router integration tests.
 *
 * AgentRunner duck-types `SmartProvider` via `provider.name === "smart-router"`
 * and chains wrappers around the provider's `config.on_decision` /
 * `on_fallback` callbacks so router events reach the EventBus tagged
 * with the right `agent_name`. We don't import `@tuttiai/router` here
 * (core must not depend on router) — instead we use a hand-rolled
 * fake that mirrors SmartProvider's observable contract.
 */

import type { TuttiSpan } from "@tuttiai/telemetry";
import type { ChatRequest, ChatResponse, LLMProvider, StreamChunk, TuttiEvent } from "@tuttiai/types";
import { describe, expect, it } from "vitest";
import { AgentRunner } from "../src/agent-runner.js";
import { EventBus } from "../src/event-bus.js";
import { InMemorySessionStore } from "../src/session-store.js";
import { getTuttiTracer } from "../src/telemetry.js";
import { simpleAgent, textResponse } from "./helpers/mock-provider.js";

interface RouterDecisionPayload {
  tier: string;
  model: string;
  reason: string;
  classifier: string;
  estimated_input_tokens: number;
  estimated_cost_usd: number;
}

interface RouterFallbackPayload {
  from_model: string;
  to_model: string;
  error: string;
}

interface FakeSmartProviderOptions {
  decision: RouterDecisionPayload;
  /** When set, simulates the primary tier failing — on_fallback fires, then a second on_decision is recorded. */
  fallback?: RouterFallbackPayload;
}

/**
 * Minimal SmartProvider lookalike. Reproduces the two surfaces
 * AgentRunner depends on for routing-event wiring: the `name` marker
 * and the `config.on_decision` / `config.on_fallback` callbacks. We
 * insert an `await Promise.resolve()` before firing on_decision so the
 * test exercises the cross-await path that requires AsyncLocalStorage
 * (a per-runner field would race here).
 */
class FakeSmartProvider implements LLMProvider {
  readonly name = "smart-router";
  config: {
    on_decision?: (decision: RouterDecisionPayload) => void;
    on_fallback?: (info: RouterFallbackPayload) => void;
  } = {};

  constructor(private opts: FakeSmartProviderOptions) {}

  async chat(_req: ChatRequest): Promise<ChatResponse> {
    // Simulate the classifier microtask: this awaits before firing
    // on_decision, which is the path that would race a class field.
    await Promise.resolve();
    this.config.on_decision?.(this.opts.decision);
    if (this.opts.fallback) {
      this.config.on_fallback?.(this.opts.fallback);
      this.config.on_decision?.({
        ...this.opts.decision,
        model: this.opts.fallback.to_model,
        reason: `fallback after error: ${this.opts.fallback.error}`,
      });
    }
    return textResponse("ok");
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async *stream(_req: ChatRequest): AsyncGenerator<StreamChunk> {
    // Unused by these tests — present to satisfy LLMProvider.
  }
}

const BASE_DECISION: RouterDecisionPayload = {
  tier: "small",
  model: "small-m",
  reason: "classified",
  classifier: "heuristic",
  estimated_input_tokens: 42,
  estimated_cost_usd: 0.0001,
};

describe("AgentRunner router-event wiring", () => {
  it("emits router:decision with the correct agent_name when a smart-router provider is used", async () => {
    const provider = new FakeSmartProvider({ decision: BASE_DECISION });
    const events = new EventBus();
    const decisions: Extract<TuttiEvent, { type: "router:decision" }>[] = [];
    events.on("router:decision", (e) => decisions.push(e));

    const runner = new AgentRunner(provider, events, new InMemorySessionStore());
    await runner.run(simpleAgent, "hi");

    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.agent_name).toBe(simpleAgent.name);
    expect(decisions[0]?.tier).toBe("small");
    expect(decisions[0]?.model).toBe("small-m");
    expect(decisions[0]?.classifier).toBe("heuristic");
    expect(decisions[0]?.estimated_input_tokens).toBe(42);
  });

  it("emits router:fallback (and a second router:decision) when the primary tier fails", async () => {
    const provider = new FakeSmartProvider({
      decision: BASE_DECISION,
      fallback: { from_model: "small-m", to_model: "fallback-m", error: "boom" },
    });
    const events = new EventBus();
    const fallbacks: Extract<TuttiEvent, { type: "router:fallback" }>[] = [];
    const decisions: Extract<TuttiEvent, { type: "router:decision" }>[] = [];
    events.on("router:fallback", (e) => fallbacks.push(e));
    events.on("router:decision", (e) => decisions.push(e));

    const runner = new AgentRunner(provider, events, new InMemorySessionStore());
    await runner.run(simpleAgent, "hi");

    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0]?.from_model).toBe("small-m");
    expect(fallbacks[0]?.to_model).toBe("fallback-m");
    expect(fallbacks[0]?.error).toBe("boom");
    expect(fallbacks[0]?.agent_name).toBe(simpleAgent.name);

    expect(decisions).toHaveLength(2);
    expect(decisions[1]?.model).toBe("fallback-m");
    expect(decisions[1]?.reason).toMatch(/^fallback after error:/);
  });

  it("preserves the user's existing on_decision and on_fallback callbacks (chains, never replaces)", async () => {
    const provider = new FakeSmartProvider({
      decision: BASE_DECISION,
      fallback: { from_model: "small-m", to_model: "fallback-m", error: "boom" },
    });
    const userDecisions: RouterDecisionPayload[] = [];
    const userFallbacks: RouterFallbackPayload[] = [];
    provider.config.on_decision = (d) => userDecisions.push(d);
    provider.config.on_fallback = (i) => userFallbacks.push(i);

    const events = new EventBus();
    const runner = new AgentRunner(provider, events, new InMemorySessionStore());
    await runner.run(simpleAgent, "hi");

    // Both the user's pre-existing callbacks AND the runner's wrapper fired.
    expect(userDecisions).toHaveLength(2);
    expect(userFallbacks).toHaveLength(1);
    expect(userFallbacks[0]?.error).toBe("boom");
  });

  it("threads agent_name through AsyncLocalStorage for concurrent runs (no race under parallel agents)", async () => {
    const provider = new FakeSmartProvider({ decision: BASE_DECISION });
    const events = new EventBus();
    const seen: { agent_name: string }[] = [];
    events.on("router:decision", (e) => seen.push({ agent_name: e.agent_name }));

    const runner = new AgentRunner(provider, events, new InMemorySessionStore());
    const agentA = { ...simpleAgent, name: "agent-a" };
    const agentB = { ...simpleAgent, name: "agent-b" };

    await Promise.all([runner.run(agentA, "hi"), runner.run(agentB, "hi")]);

    // Two router decisions, one per agent. ALS must keep them separated
    // even though both runs hit the shared FakeSmartProvider concurrently.
    expect(seen).toHaveLength(2);
    expect(seen.map((d) => d.agent_name).sort()).toEqual(["agent-a", "agent-b"]);
  });

  it("mirrors the router decision onto the active llm.completion span", async () => {
    const provider = new FakeSmartProvider({ decision: BASE_DECISION });
    const events = new EventBus();
    // Capture every closed span so we can assert on the llm.completion one.
    const closed: TuttiSpan[] = [];
    const unsubscribe = getTuttiTracer().subscribe((s) => {
      if (s.status !== "running") closed.push(s);
    });

    try {
      const runner = new AgentRunner(provider, events, new InMemorySessionStore());
      await runner.run(simpleAgent, "hi");
    } finally {
      unsubscribe();
    }

    const llmSpan = closed.find((s) => s.name === "llm.completion");
    expect(llmSpan, "expected an llm.completion span to close").toBeDefined();
    expect(llmSpan?.attributes.router_tier).toBe("small");
    expect(llmSpan?.attributes.router_model).toBe("small-m");
    expect(llmSpan?.attributes.router_classifier).toBe("heuristic");
    expect(llmSpan?.attributes.router_reason).toBe("classified");
    expect(llmSpan?.attributes.router_cost_estimate).toBeCloseTo(BASE_DECISION.estimated_cost_usd);
  });

  it("mirrors fallback metadata onto the active llm.completion span when fallback fires", async () => {
    const provider = new FakeSmartProvider({
      decision: BASE_DECISION,
      fallback: { from_model: "small-m", to_model: "fallback-m", error: "boom" },
    });
    const events = new EventBus();
    const closed: TuttiSpan[] = [];
    const unsubscribe = getTuttiTracer().subscribe((s) => {
      if (s.status !== "running") closed.push(s);
    });

    try {
      const runner = new AgentRunner(provider, events, new InMemorySessionStore());
      await runner.run(simpleAgent, "hi");
    } finally {
      unsubscribe();
    }

    const llmSpan = closed.find((s) => s.name === "llm.completion");
    expect(llmSpan?.attributes.router_fallback_from).toBe("small-m");
    expect(llmSpan?.attributes.router_fallback_to).toBe("fallback-m");
    expect(llmSpan?.attributes.router_fallback_error).toBe("boom");
    // The second decision (post-fallback) overwrites router_model + reason.
    expect(llmSpan?.attributes.router_model).toBe("fallback-m");
    expect(llmSpan?.attributes.router_reason).toMatch(/^fallback after error:/);
  });

  it("does not emit router events for non-router providers", async () => {
    // Use the standard mock-provider helper — no `name` marker.
    const { createMockProvider } = await import("./helpers/mock-provider.js");
    const provider = createMockProvider([textResponse("plain")]);
    const events = new EventBus();
    const seen: TuttiEvent[] = [];
    events.on("router:decision", (e) => seen.push(e));
    events.on("router:fallback", (e) => seen.push(e));

    const runner = new AgentRunner(provider, events, new InMemorySessionStore());
    await runner.run(simpleAgent, "hi");

    expect(seen).toHaveLength(0);
  });
});
