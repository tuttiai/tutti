import { describe, it, expect } from "vitest";
import { z } from "zod";
import { AgentRunner } from "../src/agent-runner.js";
import { StructuredOutputError } from "../src/errors.js";
import { EventBus } from "../src/event-bus.js";
import { InMemorySessionStore } from "../src/session-store.js";
import {
  createMockProvider,
  textResponse,
  simpleAgent,
} from "./helpers/mock-provider.js";

const PersonSchema = z.object({
  name: z.string(),
  age: z.number(),
});

describe("AgentRunner — structured output", () => {
  it("parses valid JSON on the first try", async () => {
    const provider = createMockProvider([
      textResponse('{"name":"Alice","age":30}'),
    ]);
    const events = new EventBus();
    const sessions = new InMemorySessionStore();
    const runner = new AgentRunner(provider, events, sessions);

    const result = await runner.run(
      { ...simpleAgent, outputSchema: PersonSchema },
      "Give me a person",
    );

    expect(result.structured).toEqual({ name: "Alice", age: 30 });
    expect(result.output).toBe('{"name":"Alice","age":30}');
    expect(result.turns).toBe(1);
    expect(provider.chat).toHaveBeenCalledTimes(1);
  });

  it("retries once and succeeds on the second attempt", async () => {
    const provider = createMockProvider([
      textResponse("not json at all"),
      textResponse('{"name":"Bob","age":25}'),
    ]);
    const events = new EventBus();
    const sessions = new InMemorySessionStore();
    const runner = new AgentRunner(provider, events, sessions);

    const result = await runner.run(
      { ...simpleAgent, outputSchema: PersonSchema },
      "Give me a person",
    );

    expect(result.structured).toEqual({ name: "Bob", age: 25 });
    expect(result.output).toBe('{"name":"Bob","age":25}');
    expect(result.turns).toBe(2);
    expect(provider.chat).toHaveBeenCalledTimes(2);

    // The retry message should tell the LLM what went wrong.
    // Note: mock captures a reference — the array has been mutated by the
    // time we inspect it, so the error user message sits at index -2.
    const retryCall = provider.chat.mock.calls[1]?.[0];
    const errorMsg = retryCall?.messages?.find(
      (m: { role: string; content: unknown }) =>
        m.role === "user" && typeof m.content === "string" && m.content.includes("invalid JSON"),
    );
    expect(errorMsg).toBeDefined();
  });

  it("throws StructuredOutputError after maxRetries failures", async () => {
    const provider = createMockProvider([
      textResponse("bad1"),
      textResponse("bad2"),
      textResponse("bad3"),
      textResponse("bad4"),
    ]);
    const events = new EventBus();
    const sessions = new InMemorySessionStore();
    const runner = new AgentRunner(provider, events, sessions);

    await expect(
      runner.run(
        { ...simpleAgent, outputSchema: PersonSchema, maxRetries: 2 },
        "Give me a person",
      ),
    ).rejects.toThrow(StructuredOutputError);

    // 1 initial + 2 retries = 3 total calls
    expect(provider.chat).toHaveBeenCalledTimes(3);
  });

  it("retries when JSON is valid but fails Zod schema validation", async () => {
    const provider = createMockProvider([
      textResponse('{"name":"Alice","age":"not-a-number"}'),
      textResponse('{"name":"Alice","age":30}'),
    ]);
    const events = new EventBus();
    const sessions = new InMemorySessionStore();
    const runner = new AgentRunner(provider, events, sessions);

    const result = await runner.run(
      { ...simpleAgent, outputSchema: PersonSchema },
      "Give me a person",
    );

    expect(result.structured).toEqual({ name: "Alice", age: 30 });
    expect(result.turns).toBe(2);
  });

  it("injects schema instruction into the system prompt", async () => {
    const provider = createMockProvider([
      textResponse('{"name":"Carol","age":40}'),
    ]);
    const events = new EventBus();
    const sessions = new InMemorySessionStore();
    const runner = new AgentRunner(provider, events, sessions);

    await runner.run(
      { ...simpleAgent, outputSchema: PersonSchema },
      "Give me a person",
    );

    const request = provider.chat.mock.calls[0]?.[0];
    expect(request?.system).toContain(
      "You must respond with a valid JSON object matching this schema:",
    );
    expect(request?.system).toContain('"name"');
    expect(request?.system).toContain('"age"');
  });

  it("does not set structured when outputSchema is not configured", async () => {
    const provider = createMockProvider([textResponse("plain text")]);
    const events = new EventBus();
    const sessions = new InMemorySessionStore();
    const runner = new AgentRunner(provider, events, sessions);

    const result = await runner.run(simpleAgent, "Hello");

    expect(result.structured).toBeUndefined();
  });
});
