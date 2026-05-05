import { describe, it, expect } from "vitest";

import type { AgentConfig, ChatResponse } from "@tuttiai/types";

import { TuttiGraph } from "../../src/graph/index.js";
import { END } from "../../src/graph/types.js";
import type { GraphEvent } from "../../src/graph/types.js";
import { AgentRunner } from "../../src/agent-runner.js";
import { EventBus } from "../../src/event-bus.js";
import { InMemorySessionStore } from "../../src/session-store.js";
import { InMemorySemanticStore } from "../../src/memory/in-memory-semantic.js";
import { InMemoryToolCache } from "../../src/cache/in-memory-cache.js";

function agent(name: string): AgentConfig {
  return {
    name,
    model: "test-model",
    system_prompt: `You are ${name}.`,
    voices: [],
  };
}

function textResponse(text: string): ChatResponse {
  return {
    id: `r-${Math.random().toString(36).slice(2, 8)}`,
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

function createRunner(replies: ChatResponse[]): AgentRunner {
  let i = 0;
  const provider = {
    async chat(): Promise<ChatResponse> {
      const reply = replies[i++ % replies.length];
      if (!reply) throw new Error("no more replies");
      return reply;
    },
  };
  return new AgentRunner(
    provider,
    new EventBus(),
    new InMemorySessionStore(),
    new InMemorySemanticStore(),
    undefined,
    new InMemoryToolCache(),
  );
}

function failingRunner(failOnAgentName: string): AgentRunner {
  const provider = {
    async chat(): Promise<ChatResponse> {
      // Fail unconditionally — the test is set up so only one node calls
      // this provider before erroring.
      throw new Error("boom from " + failOnAgentName);
    },
  };
  return new AgentRunner(
    provider,
    new EventBus(),
    new InMemorySessionStore(),
    new InMemorySemanticStore(),
    undefined,
    new InMemoryToolCache(),
  );
}

describe("TuttiGraph.subscribe", () => {
  it("delivers events from run() to every active subscriber", async () => {
    const runner = createRunner([textResponse("a"), textResponse("b"), textResponse("c")]);

    const graph = new TuttiGraph(
      {
        entrypoint: "x",
        nodes: [
          { id: "x", agent: agent("x") },
          { id: "y", agent: agent("y") },
          { id: "z", agent: agent("z") },
        ],
        edges: [
          { from: "x", to: "y" },
          { from: "y", to: "z" },
          { from: "z", to: END },
        ],
      },
      runner,
    );

    const events: GraphEvent[] = [];
    graph.subscribe((e) => events.push(e));

    await graph.run("hello");

    const types = events.map((e) => e.type);
    expect(types[0]).toBe("graph:start");
    expect(types).toContain("node:start");
    expect(types).toContain("node:end");
    expect(types[types.length - 1]).toBe("graph:end");
    // Every node:start should be followed by a node:end for that node.
    const nodeStarts = events.filter((e) => e.type === "node:start").length;
    const nodeEnds = events.filter((e) => e.type === "node:end").length;
    expect(nodeStarts).toBe(3);
    expect(nodeEnds).toBe(3);
  });

  it("stamps every event with the run's session_id", async () => {
    const runner = createRunner([textResponse("a"), textResponse("b")]);

    const graph = new TuttiGraph(
      {
        entrypoint: "x",
        nodes: [
          { id: "x", agent: agent("x") },
          { id: "y", agent: agent("y") },
        ],
        edges: [
          { from: "x", to: "y" },
          { from: "y", to: END },
        ],
      },
      runner,
    );

    const events: GraphEvent[] = [];
    graph.subscribe((e) => events.push(e));

    await graph.run("hi", { session_id: "session-42" });

    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(e.session_id).toBe("session-42");
    }
  });

  it("emits node:end with duration_ms", async () => {
    const runner = createRunner([textResponse("a")]);
    const graph = new TuttiGraph(
      {
        entrypoint: "x",
        nodes: [{ id: "x", agent: agent("x") }],
        edges: [{ from: "x", to: END }],
      },
      runner,
    );
    const events: GraphEvent[] = [];
    graph.subscribe((e) => events.push(e));

    await graph.run("hi");

    const ends = events.filter((e) => e.type === "node:end");
    expect(ends).toHaveLength(1);
    const end = ends[0];
    expect(end?.type).toBe("node:end");
    if (end?.type === "node:end") {
      expect(end.duration_ms).toBeGreaterThanOrEqual(0);
    }
  });

  it("emits node:error before propagating the throw", async () => {
    const graph = new TuttiGraph(
      {
        entrypoint: "x",
        nodes: [{ id: "x", agent: agent("x") }],
        edges: [{ from: "x", to: END }],
      },
      failingRunner("x"),
    );
    const events: GraphEvent[] = [];
    graph.subscribe((e) => events.push(e));

    await expect(graph.run("hi", { session_id: "s-1" })).rejects.toThrow();

    const errs = events.filter((e) => e.type === "node:error");
    expect(errs).toHaveLength(1);
    const err = errs[0];
    expect(err?.type).toBe("node:error");
    if (err?.type === "node:error") {
      expect(err.node_id).toBe("x");
      expect(err.error).toContain("boom");
      expect(err.session_id).toBe("s-1");
      expect(err.duration_ms).toBeGreaterThanOrEqual(0);
    }
    // graph:end is NOT expected when a node errors before terminating.
  });

  it("unsubscribe stops further deliveries", async () => {
    const runner = createRunner([textResponse("a"), textResponse("b")]);
    const graph = new TuttiGraph(
      {
        entrypoint: "x",
        nodes: [
          { id: "x", agent: agent("x") },
          { id: "y", agent: agent("y") },
        ],
        edges: [
          { from: "x", to: "y" },
          { from: "y", to: END },
        ],
      },
      runner,
    );

    const events: GraphEvent[] = [];
    const unsubscribe = graph.subscribe((e) => events.push(e));
    unsubscribe();

    await graph.run("hi");
    expect(events).toHaveLength(0);
  });

  it("a throwing subscriber does not break the run or other subscribers", async () => {
    const runner = createRunner([textResponse("a")]);
    const graph = new TuttiGraph(
      {
        entrypoint: "x",
        nodes: [{ id: "x", agent: agent("x") }],
        edges: [{ from: "x", to: END }],
      },
      runner,
    );

    let goodCount = 0;
    graph.subscribe(() => {
      throw new Error("bad subscriber");
    });
    graph.subscribe(() => {
      goodCount += 1;
    });

    await expect(graph.run("hi")).resolves.toBeDefined();
    expect(goodCount).toBeGreaterThan(0);
  });
});
