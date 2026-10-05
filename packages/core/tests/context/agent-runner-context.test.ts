/**
 * Integration tests for `AgentConfig.context` through the agent runner, with
 * a mock provider: what the model is sent, and what the run's usage counts.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import type { AgentConfig, ChatMessage, ChatRequest, ChatResponse, Voice } from "@tuttiai/types";

import { AgentRunner } from "../../src/agent-runner.js";
import { EventBus } from "../../src/event-bus.js";
import { InMemorySessionStore } from "../../src/session-store.js";
import { createMockProvider, simpleAgent, textResponse, toolUseResponse } from "../helpers/mock-provider.js";

const bigVoice: Voice = {
  name: "big",
  required_permissions: [],
  tools: [{
    name: "read_big",
    description: "Returns a large result.",
    parameters: z.object({}),
    execute: async () => ({ content: "x".repeat(20_000) }),
  }],
};

function sentResults(request: ChatRequest | undefined): string[] {
  return (request?.messages ?? []).flatMap((m: ChatMessage) =>
    typeof m.content === "string" ? [] : m.content.flatMap((b) => (b.type === "tool_result" ? [b.content] : [])),
  );
}

function withCache(response: ChatResponse, read: number): ChatResponse {
  return { ...response, usage: { ...response.usage, cache_read_input_tokens: read, cache_creation_input_tokens: 1 } };
}

describe("AgentRunner + context", () => {
  it("caps a tool result before the model sees it", async () => {
    const provider = createMockProvider([toolUseResponse("read_big", {}, "t1"), textResponse("done")]);
    const runner = new AgentRunner(provider, new EventBus(), new InMemorySessionStore());
    const agent: AgentConfig = { ...simpleAgent, voices: [bigVoice], context: { max_tool_result_chars: 1_000 } };
    await runner.run(agent, "go");
    const [result] = sentResults(provider.chat.mock.calls.at(1)?.at(0) as ChatRequest | undefined);
    expect(result?.length).toBeLessThan(1_200);
    expect(result).toContain("characters left out");
  });

  it("sends results whole when the agent sets no context", async () => {
    const provider = createMockProvider([toolUseResponse("read_big", {}, "t1"), textResponse("done")]);
    const runner = new AgentRunner(provider, new EventBus(), new InMemorySessionStore());
    await runner.run({ ...simpleAgent, voices: [bigVoice] }, "go");
    const [result] = sentResults(provider.chat.mock.calls.at(1)?.at(0) as ChatRequest | undefined);
    expect(result?.length).toBeGreaterThan(20_000);
  });

  it("counts a summary's model call in the run's usage", async () => {
    const provider = createMockProvider([
      toolUseResponse("read_big", {}, "t1"),
      toolUseResponse("read_big", {}, "t2"),
      textResponse("summary of the reads"),
      textResponse("done"),
    ]);
    const runner = new AgentRunner(provider, new EventBus(), new InMemorySessionStore());
    const agent: AgentConfig = {
      ...simpleAgent,
      voices: [bigVoice],
      context: { summarise_after_tokens: 1_000, keep_recent_messages: 2 },
    };
    const result = await runner.run(agent, "go");
    expect(result.output).toBe("done");
    // Two tool turns (15 in each), the summary (10) and the answer (10).
    expect(result.usage.input_tokens).toBe(50);
    const final = provider.chat.mock.calls.at(3)?.at(0) as ChatRequest | undefined;
    expect(JSON.stringify(final?.messages.at(0))).toContain("summary of the reads");
  });

  it("adds up cache figures across turns", async () => {
    const provider = createMockProvider([withCache(toolUseResponse("read_big", {}, "t1"), 100), withCache(textResponse("done"), 200)]);
    const runner = new AgentRunner(provider, new EventBus(), new InMemorySessionStore());
    const result = await runner.run({ ...simpleAgent, voices: [bigVoice] }, "go");
    expect(result.usage).toMatchObject({ cache_read_input_tokens: 300, cache_creation_input_tokens: 2 });
  });
});
