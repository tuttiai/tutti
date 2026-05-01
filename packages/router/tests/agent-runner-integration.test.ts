/**
 * End-to-end check: a real `AgentRunner` driving a real `SmartProvider`
 * surfaces `router:decision` events on the EventBus tagged with the
 * correct `agent_name`. Catches drift in the duck-type marker
 * (`provider.name === "smart-router"`) that the unit tests in core
 * couldn't detect because they use a hand-rolled fake.
 */

import type {
  AgentConfig,
  ChatRequest,
  ChatResponse,
  LLMProvider,
  StreamChunk,
  TuttiEvent,
} from "@tuttiai/types";
import { AgentRunner, EventBus, InMemorySessionStore } from "@tuttiai/core";
import { describe, expect, it } from "vitest";
import { SmartProvider } from "../src/smart-provider.js";

/** Stub provider returning a single canned text response. */
class StubProvider implements LLMProvider {
  calls: ChatRequest[] = [];

  async chat(req: ChatRequest): Promise<ChatResponse> {
    this.calls.push(req);
    return {
      id: "msg-1",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 5, output_tokens: 3 },
    };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async *stream(_req: ChatRequest): AsyncGenerator<StreamChunk> {
    // unused in this test
  }
}

const SIMPLE_AGENT: AgentConfig = {
  name: "router-test-agent",
  model: "small-m",
  system: "You are a helpful assistant.",
  voices: [],
};

describe("SmartProvider + AgentRunner integration", () => {
  it("emits router:decision through the EventBus when AgentRunner drives a SmartProvider", async () => {
    const small = new StubProvider();
    const medium = new StubProvider();
    const provider = new SmartProvider({
      tiers: [
        { tier: "small", provider: small, model: "small-m" },
        { tier: "medium", provider: medium, model: "medium-m" },
      ],
      policy: "cost-optimised",
    });

    const events = new EventBus();
    const decisions: Extract<TuttiEvent, { type: "router:decision" }>[] = [];
    events.on("router:decision", (e) => decisions.push(e));

    const runner = new AgentRunner(provider, events, new InMemorySessionStore());
    await runner.run(SIMPLE_AGENT, "summarise this paragraph in one line");

    // Trivial prompt under cost-optimised → 'small'.
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.agent_name).toBe("router-test-agent");
    expect(decisions[0]?.tier).toBe("small");
    expect(decisions[0]?.model).toBe("small-m");
    expect(decisions[0]?.classifier).toBe("heuristic");
    expect(small.calls).toHaveLength(1);
    expect(medium.calls).toHaveLength(0);
  });
});
