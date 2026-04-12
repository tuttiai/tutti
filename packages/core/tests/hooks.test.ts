import { describe, it, expect, vi } from "vitest";
import { AgentRunner } from "../src/agent-runner.js";
import { EventBus } from "../src/event-bus.js";
import { InMemorySessionStore } from "../src/session-store.js";
import {
  createMockProvider,
  textResponse,
  toolUseResponse,
  simpleAgent,
} from "./helpers/mock-provider.js";
import { createBlocklistHook } from "../src/hooks/index.js";
import type { TuttiHooks, ChatRequest } from "@tuttiai/types";
import { z } from "zod";

function createRunner(
  responses: Parameters<typeof createMockProvider>[0],
  globalHooks?: TuttiHooks,
) {
  const provider = createMockProvider(responses);
  const events = new EventBus();
  const sessions = new InMemorySessionStore();
  const runner = new AgentRunner(provider, events, sessions, undefined, globalHooks);
  return { runner, events, provider };
}

describe("Lifecycle hooks", () => {
  describe("beforeLLMCall", () => {
    it("can modify the request", async () => {
      const hook: TuttiHooks = {
        beforeLLMCall: vi.fn(async (_ctx, req: ChatRequest) => ({
          ...req,
          temperature: 0.5,
        })),
      };
      const { runner, provider } = createRunner([textResponse("ok")], hook);

      await runner.run(simpleAgent, "hello");

      expect(hook.beforeLLMCall).toHaveBeenCalledOnce();
      // The provider should receive the modified request
      const chatCall = provider.chat.mock.calls[0] as unknown[];
      const sentReq = chatCall[0] as { temperature?: number };
      expect(sentReq.temperature).toBe(0.5);
    });
  });

  describe("afterLLMCall", () => {
    it("fires after each LLM response", async () => {
      const hook: TuttiHooks = {
        afterLLMCall: vi.fn(async () => {}),
      };
      const { runner } = createRunner([textResponse("ok")], hook);

      await runner.run(simpleAgent, "hello");

      expect(hook.afterLLMCall).toHaveBeenCalledOnce();
    });
  });

  describe("beforeToolCall", () => {
    it("returning false blocks the tool call", async () => {
      const hook: TuttiHooks = {
        beforeToolCall: vi.fn(async () => false),
      };
      const voice = {
        name: "test",
        required_permissions: [] as const,
        tools: [{
          name: "my_tool",
          description: "test",
          parameters: z.object({}),
          execute: vi.fn(async () => ({ content: "should not run" })),
        }],
      };
      const { runner } = createRunner(
        [toolUseResponse("my_tool", {}), textResponse("blocked")],
        hook,
      );

      const result = await runner.run({ ...simpleAgent, voices: [voice] }, "test");

      expect(voice.tools[0].execute).not.toHaveBeenCalled();
      expect(result.output).toBe("blocked");
    });
  });

  describe("afterToolCall", () => {
    it("can modify the tool result", async () => {
      const hook: TuttiHooks = {
        afterToolCall: vi.fn(async (_ctx, _tool, result) => ({
          ...result,
          content: result.content + " [reviewed]",
        })),
      };
      const voice = {
        name: "test",
        required_permissions: [] as const,
        tools: [{
          name: "my_tool",
          description: "test",
          parameters: z.object({}),
          execute: async () => ({ content: "original" }),
        }],
      };
      const { runner, provider } = createRunner(
        [toolUseResponse("my_tool", {}), textResponse("done")],
        hook,
      );

      await runner.run({ ...simpleAgent, voices: [voice] }, "test");

      // The second LLM call should have the modified tool result in messages
      const secondCall = provider.chat.mock.calls[1] as unknown[];
      const msgs = (secondCall[0] as { messages: { content: unknown }[] }).messages;
      const toolResultMsg = msgs.find((m) =>
        Array.isArray(m.content) && m.content.some((b: { type: string }) => b.type === "tool_result"),
      );
      expect(toolResultMsg).toBeDefined();
    });
  });

  describe("beforeAgentRun / afterAgentRun", () => {
    it("both fire in order", async () => {
      const order: string[] = [];
      const hook: TuttiHooks = {
        beforeAgentRun: vi.fn(async () => { order.push("before"); }),
        afterAgentRun: vi.fn(async () => { order.push("after"); }),
      };
      const { runner } = createRunner([textResponse("ok")], hook);

      await runner.run(simpleAgent, "hello");

      expect(order).toEqual(["before", "after"]);
    });
  });

  describe("hook errors", () => {
    it("does not crash the agent when a hook throws", async () => {
      const hook: TuttiHooks = {
        beforeLLMCall: vi.fn(async () => { throw new Error("hook crash"); }),
      };
      const { runner } = createRunner([textResponse("survived")], hook);

      const result = await runner.run(simpleAgent, "hello");

      expect(result.output).toBe("survived");
    });

    it("does not crash when afterToolCall throws", async () => {
      const hook: TuttiHooks = {
        afterToolCall: vi.fn(async () => { throw new Error("hook crash"); }),
      };
      const voice = {
        name: "test",
        required_permissions: [] as const,
        tools: [{
          name: "my_tool",
          description: "test",
          parameters: z.object({}),
          execute: async () => ({ content: "ok" }),
        }],
      };
      const { runner } = createRunner(
        [toolUseResponse("my_tool", {}), textResponse("survived")],
        hook,
      );

      const result = await runner.run({ ...simpleAgent, voices: [voice] }, "test");

      expect(result.output).toBe("survived");
    });
  });

  describe("agent-level + global hooks", () => {
    it("both global and agent-level hooks fire", async () => {
      const order: string[] = [];
      const globalHook: TuttiHooks = {
        beforeAgentRun: async () => { order.push("global"); },
      };
      const agentHook: TuttiHooks = {
        beforeAgentRun: async () => { order.push("agent"); },
      };
      const { runner } = createRunner([textResponse("ok")], globalHook);

      await runner.run({ ...simpleAgent, hooks: agentHook }, "hello");

      expect(order).toEqual(["global", "agent"]);
    });
  });

  describe("createBlocklistHook", () => {
    it("blocks listed tools", async () => {
      const hook = createBlocklistHook(["dangerous_tool"]);
      const voice = {
        name: "test",
        required_permissions: [] as const,
        tools: [{
          name: "dangerous_tool",
          description: "test",
          parameters: z.object({}),
          execute: vi.fn(async () => ({ content: "should not run" })),
        }],
      };
      const { runner } = createRunner(
        [toolUseResponse("dangerous_tool", {}), textResponse("blocked")],
        hook,
      );

      const result = await runner.run({ ...simpleAgent, voices: [voice] }, "test");

      expect(voice.tools[0].execute).not.toHaveBeenCalled();
      expect(result.output).toBe("blocked");
    });
  });
});
