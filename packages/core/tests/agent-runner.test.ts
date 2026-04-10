import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { AgentRunner } from "../src/agent-runner.js";
import { EventBus } from "../src/event-bus.js";
import { InMemorySessionStore } from "../src/session-store.js";
import {
  createMockProvider,
  textResponse,
  toolUseResponse,
  simpleAgent,
} from "./helpers/mock-provider.js";
import type { TuttiEvent, Voice } from "@tuttiai/types";

describe("AgentRunner", () => {
  it("runs a simple single-turn conversation", async () => {
    const provider = createMockProvider([textResponse("Hello!")]);
    const events = new EventBus();
    const sessions = new InMemorySessionStore();

    const runner = new AgentRunner(provider, events, sessions);
    const result = await runner.run(simpleAgent, "Hi");

    expect(result.output).toBe("Hello!");
    expect(result.turns).toBe(1);
    expect(result.usage.input_tokens).toBe(10);
    expect(result.usage.output_tokens).toBe(5);
    expect(result.session_id).toBeDefined();
  });

  it("creates a session when no session_id is provided", async () => {
    const provider = createMockProvider([textResponse("ok")]);
    const events = new EventBus();
    const sessions = new InMemorySessionStore();

    const runner = new AgentRunner(provider, events, sessions);
    const result = await runner.run(simpleAgent, "test");

    const session = sessions.get(result.session_id);
    expect(session).toBeDefined();
    expect(session!.agent_name).toBe("test-agent");
  });

  it("reuses an existing session when session_id is provided", async () => {
    const provider = createMockProvider([
      textResponse("first"),
      textResponse("second"),
    ]);
    const events = new EventBus();
    const sessions = new InMemorySessionStore();
    const runner = new AgentRunner(provider, events, sessions);

    const r1 = await runner.run(simpleAgent, "hello");
    const r2 = await runner.run(simpleAgent, "again", r1.session_id);

    expect(r2.session_id).toBe(r1.session_id);
    expect(r2.messages.length).toBeGreaterThan(r1.messages.length);
  });

  it("throws when given an invalid session_id", async () => {
    const provider = createMockProvider([textResponse("ok")]);
    const events = new EventBus();
    const sessions = new InMemorySessionStore();
    const runner = new AgentRunner(provider, events, sessions);

    await expect(
      runner.run(simpleAgent, "test", "nonexistent"),
    ).rejects.toThrow("Session not found: nonexistent");
  });

  it("executes tool calls and loops back to the LLM", async () => {
    const executeFn = vi.fn(async (input: { x: number }) => ({
      content: `Result: ${input.x * 2}`,
    }));

    const voice: Voice = {
      name: "math",
      tools: [
        {
          name: "double",
          description: "Doubles a number",
          parameters: z.object({ x: z.number() }),
          execute: executeFn,
        },
      ],
    };

    const provider = createMockProvider([
      toolUseResponse("double", { x: 21 }),
      textResponse("The answer is 42"),
    ]);
    const events = new EventBus();
    const sessions = new InMemorySessionStore();
    const runner = new AgentRunner(provider, events, sessions);

    const result = await runner.run(
      { ...simpleAgent, voices: [voice] },
      "double 21",
    );

    expect(executeFn).toHaveBeenCalledOnce();
    expect(executeFn).toHaveBeenCalledWith(
      { x: 21 },
      expect.objectContaining({ agent_name: "test-agent" }),
    );
    expect(result.output).toBe("The answer is 42");
    expect(result.turns).toBe(2);
    expect(provider.chat).toHaveBeenCalledTimes(2);
  });

  it("returns error result for unknown tool", async () => {
    const provider = createMockProvider([
      toolUseResponse("nonexistent_tool", {}),
      textResponse("ok"),
    ]);
    const events = new EventBus();
    const sessions = new InMemorySessionStore();
    const runner = new AgentRunner(provider, events, sessions);

    const result = await runner.run(simpleAgent, "test");

    // Should still complete (the error is sent back to the LLM)
    expect(result.output).toBe("ok");
    expect(result.turns).toBe(2);
  });

  it("returns error result when tool throws", async () => {
    const voice: Voice = {
      name: "failing",
      tools: [
        {
          name: "fail",
          description: "Always fails",
          parameters: z.object({}),
          execute: async () => {
            throw new Error("kaboom");
          },
        },
      ],
    };

    const provider = createMockProvider([
      toolUseResponse("fail", {}),
      textResponse("recovered"),
    ]);
    const events = new EventBus();
    const sessions = new InMemorySessionStore();
    const runner = new AgentRunner(provider, events, sessions);

    const result = await runner.run(
      { ...simpleAgent, voices: [voice] },
      "test",
    );

    expect(result.output).toBe("recovered");
  });

  it("returns error when tool input fails Zod validation", async () => {
    const voice: Voice = {
      name: "strict",
      tools: [
        {
          name: "strict_tool",
          description: "Needs a string",
          parameters: z.object({ name: z.string() }),
          execute: async (input: { name: string }) => ({
            content: input.name,
          }),
        },
      ],
    };

    const provider = createMockProvider([
      toolUseResponse("strict_tool", { name: 123 }), // wrong type
      textResponse("handled"),
    ]);
    const events = new EventBus();
    const sessions = new InMemorySessionStore();
    const runner = new AgentRunner(provider, events, sessions);

    const result = await runner.run(
      { ...simpleAgent, voices: [voice] },
      "test",
    );

    // The Zod error should be sent back as a tool_result error
    expect(result.output).toBe("handled");
  });

  it("respects max_turns limit", async () => {
    // Provider always returns tool_use, forcing an infinite loop
    const responses = Array.from({ length: 5 }, () =>
      toolUseResponse("noop", {}),
    );
    const provider = createMockProvider(responses);
    const events = new EventBus();
    const sessions = new InMemorySessionStore();
    const runner = new AgentRunner(provider, events, sessions);

    const result = await runner.run(
      { ...simpleAgent, max_turns: 3 },
      "test",
    );

    expect(result.turns).toBe(3);
    expect(provider.chat).toHaveBeenCalledTimes(3);
  });

  it("accumulates token usage across turns", async () => {
    const provider = createMockProvider([
      {
        id: "r1",
        content: [
          { type: "tool_use", id: "t1", name: "noop", input: {} },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 100, output_tokens: 50 },
      },
      {
        id: "r2",
        content: [{ type: "text", text: "done" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 200, output_tokens: 30 },
      },
    ]);
    const events = new EventBus();
    const sessions = new InMemorySessionStore();
    const runner = new AgentRunner(provider, events, sessions);

    const result = await runner.run(simpleAgent, "test");

    expect(result.usage.input_tokens).toBe(300);
    expect(result.usage.output_tokens).toBe(80);
  });

  it("emits the full event lifecycle", async () => {
    const provider = createMockProvider([textResponse("hi")]);
    const events = new EventBus();
    const sessions = new InMemorySessionStore();
    const runner = new AgentRunner(provider, events, sessions);

    const emitted: string[] = [];
    events.onAny((e: TuttiEvent) => emitted.push(e.type));

    await runner.run(simpleAgent, "test");

    expect(emitted).toEqual([
      "agent:start",
      "turn:start",
      "llm:request",
      "llm:response",
      "turn:end",
      "agent:end",
    ]);
  });

  it("emits tool events during tool execution", async () => {
    const voice: Voice = {
      name: "tools",
      tools: [
        {
          name: "echo",
          description: "Echoes",
          parameters: z.object({ msg: z.string() }),
          execute: async (input: { msg: string }) => ({
            content: input.msg,
          }),
        },
      ],
    };

    const provider = createMockProvider([
      toolUseResponse("echo", { msg: "hi" }),
      textResponse("done"),
    ]);
    const events = new EventBus();
    const sessions = new InMemorySessionStore();
    const runner = new AgentRunner(provider, events, sessions);

    const emitted: string[] = [];
    events.onAny((e: TuttiEvent) => emitted.push(e.type));

    await runner.run({ ...simpleAgent, voices: [voice] }, "test");

    expect(emitted).toContain("tool:start");
    expect(emitted).toContain("tool:end");
  });

  it("emits tool:error when a tool throws", async () => {
    const voice: Voice = {
      name: "broken",
      tools: [
        {
          name: "boom",
          description: "Explodes",
          parameters: z.object({}),
          execute: async () => {
            throw new Error("explosion");
          },
        },
      ],
    };

    const provider = createMockProvider([
      toolUseResponse("boom", {}),
      textResponse("ok"),
    ]);
    const events = new EventBus();
    const sessions = new InMemorySessionStore();
    const runner = new AgentRunner(provider, events, sessions);

    const errors: TuttiEvent[] = [];
    events.on("tool:error", (e) => errors.push(e));

    await runner.run({ ...simpleAgent, voices: [voice] }, "test");

    expect(errors).toHaveLength(1);
    expect(errors[0].type).toBe("tool:error");
  });

  it("persists messages to the session store", async () => {
    const provider = createMockProvider([textResponse("response")]);
    const events = new EventBus();
    const sessions = new InMemorySessionStore();
    const runner = new AgentRunner(provider, events, sessions);

    const result = await runner.run(simpleAgent, "input");
    const session = sessions.get(result.session_id)!;

    expect(session.messages).toHaveLength(2);
    expect(session.messages[0]).toEqual({
      role: "user",
      content: "input",
    });
    expect(session.messages[1].role).toBe("assistant");
  });
});
