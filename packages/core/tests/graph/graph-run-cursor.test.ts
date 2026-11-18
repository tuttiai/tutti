/**
 * Pins the observable behaviour of a graph without waits: the full result
 * and the exact event sequence of a run with shared state, a parallel fork
 * and a merge. Guards the run-cursor refactor of the engine loop.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ChatResponse } from "@tuttiai/types";
import { AgentRunner } from "../../src/agent-runner.js";
import { EventBus } from "../../src/event-bus.js";
import { InMemorySessionStore } from "../../src/session-store.js";
import { TuttiGraph } from "../../src/graph/index.js";
import { END } from "../../src/graph/types.js";
import type { GraphConfig, GraphEvent, NodeResult } from "../../src/graph/types.js";
import { GraphCycleError } from "../../src/graph/errors.js";
import { createMockProvider, textResponse } from "../helpers/mock-provider.js";
import { agent } from "./wait-fixtures.js";

/** A response whose text parses as a structured `state_update`. */
function withState(update: Record<string, unknown>): ChatResponse {
  return textResponse(JSON.stringify({ state_update: update }));
}

function runnerFor(responses: ChatResponse[]): AgentRunner {
  return new AgentRunner(createMockProvider(responses), new EventBus(), new InMemorySessionStore());
}

const forkConfig: GraphConfig = {
  entrypoint: "router",
  nodes: [
    { id: "router", agent: agent("router") },
    { id: "A", agent: agent("A") },
    { id: "B", agent: agent("B") },
    { id: "merge", agent: agent("merge"), merge: true },
  ],
  edges: [
    { from: "router", to: "A", parallel: true },
    { from: "router", to: "B", parallel: true },
    { from: "A", to: "merge" },
    { from: "B", to: "merge" },
    { from: "merge", to: END },
  ],
};

function meta(): NodeResult["metadata"] {
  return { duration_ms: 0, turns: 1, input_tokens: 10, output_tokens: 5 };
}

describe("graph run cursor: behaviour without waits", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-16T20:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the same result for a parallel fork and merge", async () => {
    const responses = ["route", "branch-A", "branch-B", "merged"].map((t) => textResponse(t));
    const result = await new TuttiGraph(forkConfig, runnerFor(responses)).run("go", { session_id: "s1" });
    expect(result).toStrictEqual({
      outputs: {
        router: { output: "route", structured: undefined, metadata: meta() },
        A: { output: "branch-A", structured: undefined, metadata: meta() },
        B: { output: "branch-B", structured: undefined, metadata: meta() },
        merge: { output: "merged", structured: undefined, metadata: meta() },
      },
      path: ["router", "A", "B", "merge"],
      final_output: "merged",
      total_usage: { input_tokens: 40, output_tokens: 20 },
      duration_ms: 0,
    });
  });

  it("emits the same event sequence, stamped with the session id", async () => {
    const responses = ["route", "branch-A", "branch-B", "merged"].map((t) => textResponse(t));
    const events: GraphEvent[] = [];
    for await (const e of new TuttiGraph(forkConfig, runnerFor(responses)).stream("go", { session_id: "s1" })) {
      events.push(e);
    }
    expect(events.map((e) => `${e.type}:${"node_id" in e ? e.node_id : ""}${"to" in e ? e.to : ""}`)).toStrictEqual([
      "graph:start:", "node:start:router", "node:end:router",
      "edge:traverse:A", "edge:traverse:B",
      "node:start:A", "node:start:B", "node:end:A", "node:end:B",
      "edge:traverse:merge", "edge:traverse:merge",
      "node:start:merge", "node:end:merge", "edge:traverse:__end__", "graph:end:",
    ]);
    expect(events.every((e) => e.session_id === "s1")).toBe(true);
    const mergeStart = events.find((e) => e.type === "node:start" && e.node_id === "merge");
    expect(mergeStart).toMatchObject({ input: "[from: A]\nbranch-A\n\n[from: B]\nbranch-B" });
  });

  it("keeps state updates, schema defaults and final_state", async () => {
    const config: GraphConfig = {
      entrypoint: "a",
      state: z.object({ count: z.number().default(0), tag: z.string().optional() }),
      nodes: [
        { id: "a", agent: { ...agent("a"), outputSchema: z.object({ state_update: z.object({ count: z.number() }) }) } },
        { id: "b", agent: agent("b") },
      ],
      edges: [{ from: "a", to: "b" }, { from: "b", to: END }],
    };
    const graph = new TuttiGraph(config, runnerFor([withState({ count: 1 }), textResponse("done")]));
    const events: GraphEvent[] = [];
    graph.subscribe((e) => events.push(e));
    const result = await graph.run("go");
    expect(result.final_state).toStrictEqual({ count: 1 });
    expect(result.path).toStrictEqual(["a", "b"]);
    expect(events.filter((e) => e.type === "state:update")).toStrictEqual([
      { type: "state:update", node_id: "a", state: { count: 1 } },
    ]);
  });

  it("ends on an implicit END when no conditional edge matches", async () => {
    const config: GraphConfig = {
      entrypoint: "a",
      nodes: [{ id: "a", agent: agent("a") }, { id: "b", agent: agent("b") }],
      edges: [{ from: "a", to: "b", condition: () => false }, { from: "b", to: END }],
    };
    const result = await new TuttiGraph(config, runnerFor([textResponse("only-a")])).run("go");
    expect(result.path).toStrictEqual(["a"]);
    expect(result.final_output).toBe("only-a");
  });

  it("still throws GraphCycleError past max_node_visits", async () => {
    const config: GraphConfig = {
      entrypoint: "a",
      nodes: [{ id: "a", agent: agent("a") }],
      edges: [{ from: "a", to: "a" }],
    };
    const responses = ["1", "2", "3"].map((t) => textResponse(t));
    const graph = new TuttiGraph(config, runnerFor(responses));
    await expect(graph.run("go", { max_node_visits: 2 })).rejects.toThrow(GraphCycleError);
  });

  it("emits node:error and rethrows when a node's agent fails", async () => {
    const config: GraphConfig = {
      entrypoint: "a",
      nodes: [{ id: "a", agent: agent("a") }],
      edges: [{ from: "a", to: END }],
    };
    const graph = new TuttiGraph(config, runnerFor([]));
    const events: GraphEvent[] = [];
    graph.subscribe((e) => events.push(e));
    await expect(graph.run("go")).rejects.toThrow();
    expect(events.map((e) => e.type)).toStrictEqual(["graph:start", "node:start", "node:error"]);
  });
});
