import type { ChatRequest, ChatResponse, LLMProvider, StreamChunk } from "@tuttiai/types";
import { describe, expect, it, vi } from "vitest";
import { SmartProvider } from "../src/smart-provider.js";
import type { ModelTier, Tier } from "../src/types.js";

function reply(text: string): ChatResponse {
  return {
    id: "msg-paths",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

async function* emit(chunks: StreamChunk[]): AsyncGenerator<StreamChunk> {
  for await (const chunk of chunks) yield chunk;
}

/** Provider stub that records chat and stream requests and can be told to fail. */
class PathStub implements LLMProvider {
  calls: ChatRequest[] = [];
  streamed: ChatRequest[] = [];
  failWith: Error | undefined;
  answer = "ok";

  async chat(req: ChatRequest): Promise<ChatResponse> {
    this.calls.push(req);
    if (this.failWith) throw this.failWith;
    return Promise.resolve(reply(this.answer));
  }

  stream(req: ChatRequest): AsyncGenerator<StreamChunk> {
    this.streamed.push(req);
    return emit([{ type: "text", text: "hello" }, { type: "text", text: " world" }]);
  }
}

function tier(name: Tier, model: string, extra: Partial<ModelTier> = {}): { tier: ModelTier; stub: PathStub } {
  const stub = new PathStub();
  return { tier: { tier: name, provider: stub, model, ...extra }, stub };
}

const SIMPLE: ChatRequest = { messages: [{ role: "user", content: "summarise this" }] };

describe("SmartProvider.stream", () => {
  it("streams from the classified tier and records the decision", async () => {
    const small = tier("small", "small-m");
    const onDecision = vi.fn();
    const provider = new SmartProvider({ tiers: [small.tier], on_decision: onDecision });

    const texts: string[] = [];
    for await (const chunk of provider.stream(SIMPLE)) texts.push(chunk.text ?? "");

    expect(texts.join("")).toBe("hello world");
    expect(small.stub.streamed[0]?.model).toBe("small-m");
    expect(onDecision).toHaveBeenCalledTimes(1);
    expect(provider.getLastDecision()?.reason).toBe("classified");
  });

  it("honours force_tier and force_reason when streaming", async () => {
    const small = tier("small", "small-m");
    const large = tier("large", "large-m");
    const provider = new SmartProvider({ tiers: [small.tier, large.tier] });

    for await (const chunk of provider.stream(SIMPLE, { force_tier: "large", force_reason: "pinned" })) {
      expect(chunk.type).toBe("text");
    }

    expect(large.stub.streamed).toHaveLength(1);
    expect(small.stub.streamed).toHaveLength(0);
    expect(provider.getLastDecision()?.reason).toBe("pinned");
  });
});

describe("SmartProvider.chat errors", () => {
  it("rethrows the provider error when no fallback tier is configured", async () => {
    const small = tier("small", "small-m");
    small.stub.failWith = new Error("upstream down");
    const provider = new SmartProvider({ tiers: [small.tier] });

    await expect(provider.chat(SIMPLE)).rejects.toThrow("upstream down");
  });

  it("rethrows when the failing tier is itself the fallback tier", async () => {
    const only = tier("fallback", "fallback-m");
    only.stub.failWith = new Error("fallback down");
    const onFallback = vi.fn();
    const provider = new SmartProvider({ tiers: [only.tier], on_fallback: onFallback });

    await expect(provider.chat(SIMPLE)).rejects.toThrow("fallback down");
    expect(onFallback).not.toHaveBeenCalled();
  });
});

describe("SmartProvider tier selection", () => {
  it("walks down to the next configured tier when the classified one is missing", async () => {
    const medium = tier("medium", "medium-m");
    const large = tier("large", "large-m");
    const provider = new SmartProvider({ tiers: [large.tier, medium.tier], policy: "cost-optimised" });

    const decision = await provider.previewDecision(SIMPLE);

    expect(decision.tier).toBe("medium");
  });

  it("uses the first tier when nothing at or after the classified tier exists", async () => {
    const small = tier("small", "small-m");
    const provider = new SmartProvider({ tiers: [small.tier], policy: "quality-first" });

    const decision = await provider.previewDecision(SIMPLE);

    expect(decision.model).toBe("small-m");
  });
});

describe("SmartProvider classifier set-up", () => {
  it("uses the 'small' tier for the llm classifier when no classifier_provider is given", async () => {
    const small = tier("small", "small-m");
    const large = tier("large", "large-m");
    small.stub.answer = "large";
    const provider = new SmartProvider({ tiers: [small.tier, large.tier], classifier: "llm" });

    const decision = await provider.previewDecision(SIMPLE);

    expect(small.stub.calls).toHaveLength(1);
    expect(decision.tier).toBe("large");
  });

  it("maps an unrecognised llm classifier reply to 'medium'", async () => {
    const small = tier("small", "small-m");
    const medium = tier("medium", "medium-m");
    small.stub.answer = "impossible to say";
    const provider = new SmartProvider({ tiers: [small.tier, medium.tier], classifier: "llm" });

    expect((await provider.previewDecision(SIMPLE)).tier).toBe("medium");
  });

  it("throws when the llm classifier has neither classifier_provider nor a 'small' tier", () => {
    const large = tier("large", "large-m");
    expect(() => new SmartProvider({ tiers: [large.tier], classifier: "llm" })).toThrow(
      /requires either classifier_provider or a 'small' tier/,
    );
  });

  it("throws for the 'embedding' classifier, which is not implemented", () => {
    const small = tier("small", "small-m");
    expect(() => new SmartProvider({ tiers: [small.tier], classifier: "embedding" })).toThrow(
      /not yet implemented/,
    );
  });
});

describe("SmartProvider cost estimate", () => {
  it("uses a tier's own pricing override", async () => {
    const priced = tier("small", "custom-m", { pricing: { input_per_m: 1_000_000, output_per_m: 0 } });
    const provider = new SmartProvider({ tiers: [priced.tier] });

    const decision = await provider.previewDecision({ messages: [{ role: "user", content: "12345678" }] });

    expect(decision.estimated_input_tokens).toBe(2);
    expect(decision.estimated_cost_usd).toBe(2);
  });

  it("falls back to the default rates for a model missing from the pricing table", async () => {
    const unknown = tier("small", "not-a-real-model");
    const provider = new SmartProvider({ tiers: [unknown.tier] });

    const decision = await provider.previewDecision({ messages: [{ role: "user", content: "1234" }] });

    expect(decision.estimated_cost_usd).toBeCloseTo(1 / 1_000_000 + (1024 / 1_000_000) * 5, 12);
  });
});
