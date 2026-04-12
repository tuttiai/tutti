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

describe("Streaming", () => {
  describe("streamToResponse", () => {
    it("emits token:stream events for each text chunk", async () => {
      const { runner, events } = createRunner([textResponse("Hello world")]);
      const agent = { ...simpleAgent, streaming: true };

      const tokens: string[] = [];
      events.on("token:stream", (e) => tokens.push(e.text));

      const result = await runner.run(agent, "hi");

      expect(tokens.length).toBeGreaterThan(0);
      expect(tokens.join("")).toBe("Hello world");
      expect(result.output).toBe("Hello world");
    });

    it("returns correct usage from streamed response", async () => {
      const { runner } = createRunner([textResponse("test")]);
      const agent = { ...simpleAgent, streaming: true };

      const result = await runner.run(agent, "hi");

      expect(result.usage.input_tokens).toBe(10);
      expect(result.usage.output_tokens).toBe(5);
    });

    it("handles tool calls in streaming mode", async () => {
      const { runner, events } = createRunner([
        toolUseResponse("my_tool", { q: "test" }),
        textResponse("Done"),
      ]);

      const agent = {
        ...simpleAgent,
        streaming: true,
        voices: [
          {
            name: "test-voice",
            required_permissions: [],
            tools: [
              {
                name: "my_tool",
                description: "test tool",
                parameters: (await import("zod")).z.object({ q: (await import("zod")).z.string() }),
                execute: async () => ({ content: "tool result" }),
              },
            ],
          },
        ],
      };

      const streamedTokens: string[] = [];
      events.on("token:stream", (e) => streamedTokens.push(e.text));

      const result = await runner.run(agent, "use tool");

      expect(result.turns).toBe(2);
      expect(result.output).toBe("Done");
      expect(streamedTokens.join("")).toBe("Done");
    });

    it("falls back to chat() when streaming is false", async () => {
      const { runner, events, provider } = createRunner([textResponse("Non-streamed")]);
      const agent = { ...simpleAgent, streaming: false };

      const tokens: string[] = [];
      events.on("token:stream", (e) => tokens.push(e.text));

      const result = await runner.run(agent, "hi");

      expect(result.output).toBe("Non-streamed");
      expect(tokens).toHaveLength(0);
      expect(provider.chat).toHaveBeenCalledOnce();
    });

    it("defaults to non-streaming when streaming is undefined", async () => {
      const { runner, provider } = createRunner([textResponse("Default")]);

      const result = await runner.run(simpleAgent, "hi");

      expect(result.output).toBe("Default");
      expect(provider.chat).toHaveBeenCalledOnce();
    });
  });

  describe("token:stream event shape", () => {
    it("includes agent_name and text fields", async () => {
      const { runner, events } = createRunner([textResponse("Hi")]);
      const agent = { ...simpleAgent, streaming: true };

      const captured: TuttiEvent[] = [];
      events.on("token:stream", (e) => captured.push(e));

      await runner.run(agent, "hello");

      expect(captured.length).toBeGreaterThan(0);
      expect(captured[0]).toHaveProperty("type", "token:stream");
      expect(captured[0]).toHaveProperty("agent_name", "test-agent");
      expect(captured[0]).toHaveProperty("text");
    });
  });
});
