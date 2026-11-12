/**
 * `ToolContext.signal` and `ToolContext.report_progress`: each tool call gets
 * a signal of its own, aborted by a run abort or a timeout, and progress it
 * reports reaches the event stream while the call runs.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { z } from "zod";
import type { AgentConfig, ChatResponse, ToolContext, ToolResult, TuttiEvent, Voice } from "@tuttiai/types";

import { AgentRunner } from "../src/agent-runner.js";
import { EventBus } from "../src/event-bus.js";
import { InMemorySessionStore } from "../src/session-store.js";
import { RunAbortedError, ToolTimeoutError } from "../src/errors.js";
import { createMockProvider, textResponse, toolUseResponse, simpleAgent } from "./helpers/mock-provider.js";

type Execute = (input: { path: string }, context: ToolContext) => Promise<ToolResult>;

function agentWith(execute: Execute, extra: Partial<AgentConfig> = {}): AgentConfig {
  const voice: Voice = {
    name: "test-voice",
    required_permissions: [],
    tools: [{ name: "build", description: "Builds", parameters: z.object({ path: z.string() }), execute }],
  };
  return { ...simpleAgent, ...extra, voices: [voice] };
}

function twoCalls(): ChatResponse {
  return {
    id: "resp-parallel",
    content: [
      { type: "tool_use", id: "tool-1", name: "build", input: { path: "a" } },
      { type: "tool_use", id: "tool-2", name: "build", input: { path: "b" } },
    ],
    stop_reason: "tool_use",
    usage: { input_tokens: 15, output_tokens: 10 },
  };
}

function setup(responses: ChatResponse[]): { runner: AgentRunner; seen: TuttiEvent[] } {
  const events = new EventBus();
  const seen: TuttiEvent[] = [];
  for (const type of ["tool:start", "tool:progress", "tool:end"] as const) {
    events.on(type, (event) => seen.push(event));
  }
  const runner = new AgentRunner(createMockProvider(responses), events, new InMemorySessionStore());
  return { runner, seen };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("AgentRunner tool context", () => {
  it("puts reported progress on the event stream between tool:start and tool:end", async () => {
    const { runner, seen } = setup([toolUseResponse("build", { path: "a" }), textResponse("Done")]);
    const execute: Execute = (_input, context) => {
      context.report_progress?.({ task_id: "t-1", status: "working", progress: 1, total: 2 });
      return Promise.resolve({ content: "built" });
    };

    await runner.run(agentWith(execute), "build it");

    expect(seen.map((e) => e.type)).toEqual(["tool:start", "tool:progress", "tool:end"]);
    expect(seen[1]).toMatchObject({ tool_name: "build", tool_call_id: "tool-1", task_id: "t-1", progress: 1, total: 2 });
  });

  it("drops progress a tool reports after its call has ended", async () => {
    const { runner, seen } = setup([toolUseResponse("build", { path: "a" }), textResponse("Done")]);
    let late: ToolContext | undefined;
    const execute: Execute = (_input, context) => {
      late = context;
      return Promise.resolve({ content: "built" });
    };

    await runner.run(agentWith(execute), "build it");
    late?.report_progress?.({ progress: 2 });

    expect(seen.filter((e) => e.type === "tool:progress")).toEqual([]);
  });

  it("gives parallel calls signals of their own", async () => {
    const { runner } = setup([twoCalls(), textResponse("Done")]);
    const signals: (AbortSignal | undefined)[] = [];
    const execute: Execute = (_input, context) => {
      signals.push(context.signal);
      return Promise.resolve({ content: "built" });
    };

    await runner.run(agentWith(execute), "build both");

    expect(signals).toHaveLength(2);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[0]).not.toBe(signals[1]);
  });

  it("aborts the tool's signal with ToolTimeoutError when the call times out", async () => {
    vi.useFakeTimers();
    const { runner } = setup([toolUseResponse("build", { path: "a" }), textResponse("Done")]);
    let signal: AbortSignal | undefined;
    const execute: Execute = (_input, context) => {
      signal = context.signal;
      return new Promise<ToolResult>(() => {});
    };

    const run = runner.run(agentWith(execute, { tool_timeout_ms: 50 }), "build it");
    await vi.advanceTimersByTimeAsync(50);
    const result = await run;

    expect(signal?.aborted).toBe(true);
    expect(signal?.reason).toBeInstanceOf(ToolTimeoutError);
    expect(result.output).toBe("Done");
  });

  it("aborts the tool's signal when the run is aborted", async () => {
    const { runner } = setup([toolUseResponse("build", { path: "a" }), textResponse("Done")]);
    const controller = new AbortController();
    let signal: AbortSignal | undefined;
    const execute: Execute = (_input, context) => {
      signal = context.signal;
      controller.abort("client went away");
      return Promise.resolve({ content: "built" });
    };

    const run = runner.run(agentWith(execute), "build it", undefined, { signal: controller.signal });

    await expect(run).rejects.toBeInstanceOf(RunAbortedError);
    expect(signal?.aborted).toBe(true);
    expect(signal?.reason).toBe("client went away");
  });

  it("still runs a tool that ignores its context", async () => {
    const { runner } = setup([toolUseResponse("build", { path: "a" }), textResponse("Done")]);
    const execute: Execute = () => Promise.resolve({ content: "built" });

    const result = await runner.run(agentWith(execute), "build it");

    expect(result.output).toBe("Done");
  });
});
