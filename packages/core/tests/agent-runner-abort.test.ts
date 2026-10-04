/**
 * `AgentRunOptions.signal`: a run whose caller has gone away stops at its
 * next safe point and makes no further model or tool call.
 */

import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import type { AgentConfig, ChatRequest, TuttiEvent, Voice } from "@tuttiai/types";

import { AgentRunner } from "../src/agent-runner.js";
import { EventBus } from "../src/event-bus.js";
import { InMemorySessionStore } from "../src/session-store.js";
import { MemoryInterruptStore } from "../src/interrupt/memory-store.js";
import { ProviderError, RunAbortedError } from "../src/errors.js";
import { createMockProvider, textResponse, toolUseResponse, simpleAgent } from "./helpers/mock-provider.js";

type Execute = (input: { path: string }) => Promise<{ content: string }>;

function toolVoice(tools: Record<string, Execute>, destructive = false): Voice {
  return {
    name: "test-voice",
    required_permissions: [],
    tools: Object.entries(tools).map(([name, execute]) => ({
      name,
      description: "Does a thing",
      parameters: z.object({ path: z.string() }),
      execute,
      destructive,
    })),
  };
}

function agentWith(voice: Voice): AgentConfig {
  return { ...simpleAgent, voices: [voice] };
}

function runnerFor(provider: ReturnType<typeof createMockProvider>, store?: MemoryInterruptStore) {
  const events = new EventBus();
  const runner = new AgentRunner(
    provider, events, new InMemorySessionStore(),
    undefined, undefined, undefined, undefined, store,
  );
  return { runner, events };
}

describe("AgentRunner", () => {
  describe("run with an aborted signal", () => {
    it("makes no provider call when the signal is already aborted", async () => {
      const provider = createMockProvider([textResponse("never")]);
      const { runner } = runnerFor(provider);
      const controller = new AbortController();
      controller.abort("client disconnected");

      const run = runner.run(simpleAgent, "hello", undefined, { signal: controller.signal });

      await expect(run).rejects.toBeInstanceOf(RunAbortedError);
      await expect(run).rejects.toMatchObject({ code: "RUN_ABORTED", reason: "client disconnected" });
      expect(provider.chat).not.toHaveBeenCalled();
    });

    it("runs no later tool once the signal aborts between tool calls", async () => {
      const controller = new AbortController();
      const first = vi.fn<Execute>(() => {
        controller.abort("gave up");
        return Promise.resolve({ content: "committed" });
      });
      const second = vi.fn<Execute>(() => Promise.resolve({ content: "opened" }));
      const provider = createMockProvider([
        toolUseResponse("commit_files", { path: "a.ts" }),
        toolUseResponse("create_pull_request", { path: "a.ts" }),
        textResponse("Done"),
      ]);
      const { runner } = runnerFor(provider);

      const run = runner.run(
        agentWith(toolVoice({ commit_files: first, create_pull_request: second })),
        "ship it",
        undefined,
        { signal: controller.signal },
      );

      await expect(run).rejects.toBeInstanceOf(RunAbortedError);
      expect(first).toHaveBeenCalledOnce();
      expect(second).not.toHaveBeenCalled();
      expect(provider.chat).toHaveBeenCalledOnce();
    });

    it("does not execute a tool when the signal aborts just before it runs", async () => {
      const controller = new AbortController();
      const execute = vi.fn<Execute>(() => Promise.resolve({ content: "opened" }));
      const provider = createMockProvider([toolUseResponse("create_pull_request", { path: "a.ts" }), textResponse("Done")]);
      const { runner } = runnerFor(provider);
      const agent: AgentConfig = {
        ...agentWith(toolVoice({ create_pull_request: execute })),
        hooks: {
          beforeToolCall: () => {
            controller.abort("gave up");
            return Promise.resolve(true);
          },
        },
      };

      const run = runner.run(agent, "open a PR", undefined, { signal: controller.signal });

      await expect(run).rejects.toBeInstanceOf(RunAbortedError);
      expect(execute).not.toHaveBeenCalled();
    });

    it("ends a pending approval wait and withdraws the interrupt", async () => {
      const execute = vi.fn<Execute>(() => Promise.resolve({ content: "opened" }));
      const provider = createMockProvider([toolUseResponse("create_pull_request", { path: "a.ts" }), textResponse("Done")]);
      const store = new MemoryInterruptStore();
      const { runner, events } = runnerFor(provider, store);
      const resolved: TuttiEvent[] = [];
      events.on("interrupt:resolved", (e) => resolved.push(e));
      const requested = new Promise<string>((resolve) => {
        events.on("interrupt:requested", (e) => resolve(e.interrupt_id));
      });
      const controller = new AbortController();

      const run = runner.run(agentWith(toolVoice({ create_pull_request: execute }, true)), "open a PR", undefined, {
        signal: controller.signal,
      });
      const interruptId = await requested;
      controller.abort("client disconnected");

      await expect(run).rejects.toBeInstanceOf(RunAbortedError);
      expect(execute).not.toHaveBeenCalled();
      expect(provider.chat).toHaveBeenCalledOnce();
      await vi.waitFor(async () => {
        expect((await store.get(interruptId))?.status).toBe("denied");
      });
      expect(resolved).toMatchObject([{ interrupt_id: interruptId, status: "denied", denial_reason: "run aborted" }]);
    });

    it("stops waiting on a provider call that is in flight when the signal aborts", async () => {
      const controller = new AbortController();
      const provider = createMockProvider([]);
      provider.chat.mockImplementation(() => {
        controller.abort("timeout");
        return new Promise(() => undefined);
      });
      const { runner } = runnerFor(provider);

      const run = runner.run(simpleAgent, "hello", undefined, { signal: controller.signal });

      await expect(run).rejects.toMatchObject({ reason: "timeout" });
    });

    it("does not retry a provider call that failed because of the abort", async () => {
      const controller = new AbortController();
      const provider = createMockProvider([]);
      provider.chat.mockImplementation(() => {
        controller.abort();
        return Promise.reject(new ProviderError("Request was aborted.", { provider: "test" }));
      });
      const { runner } = runnerFor(provider);

      const run = runner.run(simpleAgent, "hello", undefined, { signal: controller.signal });

      await expect(run).rejects.toBeInstanceOf(RunAbortedError);
      expect(provider.chat).toHaveBeenCalledOnce();
    });

    it("hands the signal to the provider but keeps it out of llm:request events", async () => {
      const provider = createMockProvider([textResponse("Hi")]);
      const { runner, events } = runnerFor(provider);
      const seen: ChatRequest[] = [];
      events.on("llm:request", (e) => seen.push(e.request));
      const controller = new AbortController();

      const result = await runner.run(simpleAgent, "hello", undefined, { signal: controller.signal });

      expect(result.output).toBe("Hi");
      const sent = provider.chat.mock.calls[0]?.[0] as ChatRequest | undefined; // Safe: the runner calls chat(request).
      expect(sent?.signal).toBe(controller.signal);
      expect(seen[0]).not.toHaveProperty("signal");
    });
  });
});
