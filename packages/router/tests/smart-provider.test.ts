import type { ChatRequest, ChatResponse, LLMProvider, StreamChunk } from "@tuttiai/types";
import { describe, expect, it, vi } from "vitest";
import { SmartProvider } from "../src/smart-provider.js";
import type { ModelTier, RoutingDecision, Tier } from "../src/types.js";

const STUB_REPLY: ChatResponse = {
  id: "msg-1",
  content: [{ type: "text", text: "ok" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 5, output_tokens: 3 },
};

class StubProvider implements LLMProvider {
  calls: ChatRequest[] = [];
  shouldThrow = false;
  /** Override to control the reply payload — used by the LLM-classifier test. */
  reply: ChatResponse = STUB_REPLY;

  async chat(req: ChatRequest): Promise<ChatResponse> {
    this.calls.push(req);
    if (this.shouldThrow) throw new Error("provider boom");
    return this.reply;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async *stream(_req: ChatRequest): AsyncGenerator<StreamChunk> {
    // Unused in these tests — present to satisfy the LLMProvider interface.
  }
}

interface TierBundle {
  tier: ModelTier;
  provider: StubProvider;
}

function makeTier(name: Tier, model: string): TierBundle {
  const provider = new StubProvider();
  return { tier: { tier: name, provider, model }, provider };
}

describe("SmartProvider", () => {
  it("picks the 'small' tier for a trivial prompt under cost-optimised", async () => {
    const small = makeTier("small", "small-m");
    const medium = makeTier("medium", "medium-m");
    const large = makeTier("large", "large-m");
    const provider = new SmartProvider({
      tiers: [small.tier, medium.tier, large.tier],
      policy: "cost-optimised",
    });

    await provider.chat({
      messages: [{ role: "user", content: "summarise this paragraph in one line" }],
    });

    expect(small.provider.calls).toHaveLength(1);
    expect(small.provider.calls[0]?.model).toBe("small-m");
    expect(medium.provider.calls).toHaveLength(0);
    expect(large.provider.calls).toHaveLength(0);
  });

  it("falls back to the 'fallback' tier when the primary throws and emits on_fallback", async () => {
    const small = makeTier("small", "small-m");
    small.provider.shouldThrow = true;
    const fallback = makeTier("fallback", "fallback-m");
    const onFallback = vi.fn();

    const provider = new SmartProvider({
      tiers: [small.tier, fallback.tier],
      policy: "cost-optimised",
      on_fallback: onFallback,
    });

    const res = await provider.chat({
      messages: [{ role: "user", content: "summarise this paragraph in one line" }],
    });

    expect(res).toEqual(STUB_REPLY);
    expect(small.provider.calls).toHaveLength(1);
    expect(fallback.provider.calls).toHaveLength(1);
    expect(fallback.provider.calls[0]?.model).toBe("fallback-m");
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(onFallback).toHaveBeenCalledWith({
      from_model: "small-m",
      to_model: "fallback-m",
      error: "provider boom",
    });
  });

  it("invokes on_decision exactly once per successful call, twice when fallback fires", async () => {
    // Successful path — one decision.
    const small = makeTier("small", "small-m");
    const onSuccess = vi.fn();
    const successful = new SmartProvider({
      tiers: [small.tier],
      on_decision: onSuccess,
    });
    await successful.chat({
      messages: [{ role: "user", content: "summarise this paragraph in one line" }],
    });
    expect(onSuccess).toHaveBeenCalledTimes(1);

    // Fallback path — two decisions: one for the primary, one for the fallback.
    const failing = makeTier("small", "small-m");
    failing.provider.shouldThrow = true;
    const fallback = makeTier("fallback", "fallback-m");
    const onFallbackCall = vi.fn();
    const fallbackProvider = new SmartProvider({
      tiers: [failing.tier, fallback.tier],
      on_decision: onFallbackCall,
    });
    await fallbackProvider.chat({
      messages: [{ role: "user", content: "summarise this paragraph in one line" }],
    });
    expect(onFallbackCall).toHaveBeenCalledTimes(2);
    const reasons = onFallbackCall.mock.calls.map((c) => (c[0] as RoutingDecision).reason);
    expect(reasons[0]).toBe("classified");
    expect(reasons[1]).toMatch(/^fallback after error:/);
  });

  it("getLastDecision returns the recorded decision after a chat call", async () => {
    const small = makeTier("small", "small-m");
    const provider = new SmartProvider({ tiers: [small.tier] });
    expect(provider.getLastDecision()).toBeUndefined();

    await provider.chat({
      messages: [{ role: "user", content: "summarise this paragraph in one line" }],
    });

    const decision = provider.getLastDecision();
    expect(decision).toBeDefined();
    expect(decision?.tier).toBe("small");
    expect(decision?.model).toBe("small-m");
    expect(decision?.classifier).toBe("heuristic");
    expect(decision?.reason).toBe("classified");
    expect(decision?.estimated_input_tokens).toBeGreaterThan(0);
  });

  it("previewDecision returns a decision without calling any provider's chat", async () => {
    const small = makeTier("small", "small-m");
    const medium = makeTier("medium", "medium-m");
    const large = makeTier("large", "large-m");
    const provider = new SmartProvider({
      tiers: [small.tier, medium.tier, large.tier],
      policy: "cost-optimised",
    });

    const decision = await provider.previewDecision({
      messages: [{ role: "user", content: "summarise this paragraph in one line" }],
    });

    expect(decision.tier).toBe("small");
    expect(decision.reason).toBe("preview");
    expect(small.provider.calls).toHaveLength(0);
    expect(medium.provider.calls).toHaveLength(0);
    expect(large.provider.calls).toHaveLength(0);
    // Preview must NOT pollute lastDecision.
    expect(provider.getLastDecision()).toBeUndefined();
  });

  it("chat with override.force_tier skips classification and uses the forced tier", async () => {
    const small = makeTier("small", "small-m");
    const medium = makeTier("medium", "medium-m");
    const large = makeTier("large", "large-m");
    const provider = new SmartProvider({
      tiers: [small.tier, medium.tier, large.tier],
      policy: "cost-optimised",
    });

    // Trivial prompt would normally go to 'small'; the override forces 'large'.
    await provider.chat(
      { messages: [{ role: "user", content: "summarise this paragraph in one line" }] },
      { force_tier: "large", force_reason: "user pinned" },
    );

    expect(large.provider.calls).toHaveLength(1);
    expect(large.provider.calls[0]?.model).toBe("large-m");
    expect(small.provider.calls).toHaveLength(0);
    expect(medium.provider.calls).toHaveLength(0);
    expect(provider.getLastDecision()?.reason).toBe("user pinned");
  });

  it("throws on empty tiers", () => {
    expect(() => new SmartProvider({ tiers: [] })).toThrow(/at least one tier/);
  });

  it("uses the 'llm' classifier with a mocked classifier_provider", async () => {
    const classifierProvider = new StubProvider();
    classifierProvider.reply = {
      id: "cls-1",
      content: [{ type: "text", text: "small" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    };

    const small = makeTier("small", "small-m");
    const medium = makeTier("medium", "medium-m");
    const large = makeTier("large", "large-m");

    const provider = new SmartProvider({
      tiers: [small.tier, medium.tier, large.tier],
      classifier: "llm",
      classifier_provider: { provider: classifierProvider, model: "classifier-m" },
      // Choose a policy where the heuristic would NOT pick small for this prompt,
      // so we can prove the classifier_provider's reply ('small') is what drove routing.
      policy: "balanced",
    });

    await provider.chat({
      messages: [{ role: "user", content: "explain how a B-tree works" }],
    });

    // Classifier provider was consulted once.
    expect(classifierProvider.calls).toHaveLength(1);
    expect(classifierProvider.calls[0]?.model).toBe("classifier-m");
    // The chat call routed to 'small' because the classifier said so.
    expect(small.provider.calls).toHaveLength(1);
    expect(medium.provider.calls).toHaveLength(0);
    expect(large.provider.calls).toHaveLength(0);
  });
});
