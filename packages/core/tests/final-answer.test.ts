import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ChatRequest, TuttiEvent, Voice } from "@tuttiai/types";

import { AgentRunner } from "../src/agent-runner.js";
import { EventBus } from "../src/event-bus.js";
import { FINAL_ANSWER_REQUEST, askForFinalAnswer, stoppedMidWork } from "../src/final-answer.js";
import { InMemorySessionStore } from "../src/session-store.js";
import { createMockProvider, simpleAgent, textResponse, toolUseResponse } from "./helpers/mock-provider.js";

/** A voice with one tool that reads a file, as the framework expert's GitHub voice did. */
function reader(): Voice {
  return {
    name: "reader",
    required_permissions: [],
    tools: [{ name: "read", description: "Read a file", parameters: z.object({ path: z.string() }), execute: vi.fn(async () => ({ content: "file contents" })) }],
  };
}

describe("an agent stopped by a limit before it answered", () => {
  it("is asked once for its answer, with the tools still defined, and returns it", async () => {
    const provider = createMockProvider([
      toolUseResponse("read", { path: "a" }, "t1"),
      toolUseResponse("read", { path: "b" }, "t2"),
      textResponse("From a: the checkpointer is missing. I could not read c."),
    ]);
    const runner = new AgentRunner(provider, new EventBus(), new InMemorySessionStore());
    const result = await runner.run({ ...simpleAgent, voices: [reader()], max_tool_calls: 1 }, "Map memory");
    expect(result.output).toBe("From a: the checkpointer is missing. I could not read c.");
    expect(provider.chat).toHaveBeenCalledTimes(3);
    const last = provider.chat.mock.calls.at(-1)?.[0] as ChatRequest;
    expect(last.tools?.map((tool) => tool.name)).toEqual(["read"]);
    // The request travels with the last tool results; the array is shared, so the reply now follows it.
    expect(JSON.stringify(last.messages)).toContain(FINAL_ANSWER_REQUEST);
  });

  it("does the same when it runs out of turns", async () => {
    const provider = createMockProvider([toolUseResponse("read", { path: "a" }, "t1"), textResponse("Partial answer.")]);
    const runner = new AgentRunner(provider, new EventBus(), new InMemorySessionStore());
    const result = await runner.run({ ...simpleAgent, voices: [reader()], max_turns: 1 }, "Map memory");
    expect(result.output).toBe("Partial answer.");
  });

  it("counts the final call's tokens in the run's usage", async () => {
    const provider = createMockProvider([toolUseResponse("read", { path: "a" }, "t1"), textResponse("Done.")]);
    const runner = new AgentRunner(provider, new EventBus(), new InMemorySessionStore());
    const result = await runner.run({ ...simpleAgent, voices: [reader()], max_turns: 1 }, "Map memory");
    // 15 + 10 for the tool call, and textResponse's own usage for the final call.
    expect(result.usage.input_tokens).toBeGreaterThan(15);
  });

  it("makes no extra call for an agent that answered within its limits", async () => {
    const provider = createMockProvider([toolUseResponse("read", { path: "a" }, "t1"), textResponse("Answered.")]);
    const events: TuttiEvent[] = [];
    const bus = new EventBus();
    bus.onAny((event) => events.push(event));
    const runner = new AgentRunner(provider, bus, new InMemorySessionStore());
    const result = await runner.run({ ...simpleAgent, voices: [reader()] }, "Map memory");
    expect(result.output).toBe("Answered.");
    expect(provider.chat).toHaveBeenCalledTimes(2);
  });
});

describe("stoppedMidWork and askForFinalAnswer", () => {
  const results = { role: "user" as const, content: [{ type: "tool_result" as const, tool_use_id: "t1", content: "x" }] };

  it("recognises a history that ends on tool results, and nothing else", () => {
    expect(stoppedMidWork([{ role: "user", content: "hi" }, results])).toBe(true);
    expect(stoppedMidWork([{ role: "user", content: "hi" }])).toBe(false);
    expect(stoppedMidWork([])).toBe(false);
  });

  it("adds the request to the last tool results rather than a second user message, so turns still alternate", () => {
    const messages = [{ role: "user" as const, content: "hi" }, results];
    askForFinalAnswer(messages);
    expect(messages).toHaveLength(2);
    expect(messages.at(-1)?.content).toEqual([...results.content, { type: "text", text: FINAL_ANSWER_REQUEST }]);
  });
});
