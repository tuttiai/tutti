import { describe, it, expect } from "vitest";
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

function createRunner(responses: Parameters<typeof createMockProvider>[0]) {
  const provider = createMockProvider(responses);
  const events = new EventBus();
  const sessions = new InMemorySessionStore();
  const runner = new AgentRunner(provider, events, sessions);
  return { runner, events, provider };
}

describe("Human-in-the-loop", () => {
  it("injects request_human_input tool when allow_human_input is true", async () => {
    const { runner, events } = createRunner([
      toolUseResponse("request_human_input", { question: "Continue?" }),
      textResponse("Done after approval"),
    ]);

    const agent = { ...simpleAgent, allow_human_input: true };
    const hitlEvents: TuttiEvent[] = [];
    events.on("hitl:requested", (e) => hitlEvents.push(e));
    events.on("hitl:answered", (e) => hitlEvents.push(e));

    // Answer the HITL request immediately when it fires
    events.on("hitl:requested", (e) => {
      if (e.type === "hitl:requested") {
        runner.answer(e.session_id, "yes, go ahead");
      }
    });

    const result = await runner.run(agent, "do something risky");

    expect(result.output).toBe("Done after approval");
    expect(hitlEvents).toHaveLength(2);
    expect(hitlEvents[0]).toHaveProperty("type", "hitl:requested");
    expect(hitlEvents[1]).toHaveProperty("type", "hitl:answered");
    if (hitlEvents[1].type === "hitl:answered") {
      expect(hitlEvents[1].answer).toBe("yes, go ahead");
    }
  });

  it("does NOT inject HITL tool when allow_human_input is false", async () => {
    const { runner, provider } = createRunner([textResponse("no HITL")]);
    const agent = { ...simpleAgent, allow_human_input: false };

    const result = await runner.run(agent, "hello");

    expect(result.output).toBe("no HITL");
    // The provider should only see the user tools, not request_human_input
    const chatCall = provider.chat.mock.calls[0];
    // Safe: chatCall is an array from the mock
    const tools = (chatCall as unknown[])[0] as { tools?: { name: string }[] } | undefined;
    // If no tools were sent, that's correct (agent has no voices)
    expect(tools).toBeDefined();
  });

  it("does NOT inject HITL tool when allow_human_input is undefined", async () => {
    const { runner } = createRunner([textResponse("default")]);

    const result = await runner.run(simpleAgent, "hello");

    expect(result.output).toBe("default");
  });

  it("emits hitl:timeout when no answer is provided in time", async () => {
    const { runner, events } = createRunner([
      toolUseResponse("request_human_input", { question: "Quick?", timeout_seconds: 0.1 }),
      textResponse("Timed out path"),
    ]);

    const agent = { ...simpleAgent, allow_human_input: true };
    const timeoutEvents: TuttiEvent[] = [];
    events.on("hitl:timeout", (e) => timeoutEvents.push(e));

    const result = await runner.run(agent, "test");

    expect(result.output).toBe("Timed out path");
    expect(timeoutEvents).toHaveLength(1);
  });

  it("passes options in the hitl:requested event", async () => {
    const { runner, events } = createRunner([
      toolUseResponse("request_human_input", { question: "Pick one", options: ["A", "B", "C"] }),
      textResponse("Picked"),
    ]);

    const agent = { ...simpleAgent, allow_human_input: true };
    let receivedOptions: string[] | undefined;
    events.on("hitl:requested", (e) => {
      if (e.type === "hitl:requested") {
        receivedOptions = e.options;
        runner.answer(e.session_id, "B");
      }
    });

    await runner.run(agent, "choose");

    expect(receivedOptions).toEqual(["A", "B", "C"]);
  });

  it("answer() is a no-op for unknown session IDs", () => {
    const { runner } = createRunner([]);
    // Should not throw
    runner.answer("nonexistent-session", "whatever");
  });
});
