import { describe, it, expect } from "vitest";
import { z } from "zod";
import { TuttiGraph } from "../../src/graph/index.js";
import { END } from "../../src/graph/types.js";
import { GraphCycleError } from "../../src/graph/errors.js";
import { AgentRunner } from "../../src/agent-runner.js";
import { EventBus } from "../../src/event-bus.js";
import { InMemorySessionStore } from "../../src/session-store.js";
import { createMockProvider, textResponse } from "../helpers/mock-provider.js";
import type { AgentConfig, ChatResponse } from "@tuttiai/types";
import type { GraphEvent, NodeResult } from "../../src/graph/types.js";

/** Shorthand: build a minimal agent config with a given name. */
function agent(name: string): AgentConfig {
  return {
    name,
    model: "test-model",
    system_prompt: `You are the ${name} agent.`,
    voices: [],
  };
}

/** Build a runner backed by a mock provider that returns responses in sequence. */
function createRunner(responses: ChatResponse[]): AgentRunner {
  const provider = createMockProvider(responses);
  const events = new EventBus();
  const sessions = new InMemorySessionStore();
  return new AgentRunner(provider, events, sessions);
}

// ─────────────────────────────────────────────────────────────────
// 1. Linear chain: A → B → C → END
// ─────────────────────────────────────────────────────────────────
describe("TuttiGraph — linear chain", () => {
  it("executes nodes in sequence and returns the final output", async () => {
    const runner = createRunner([
      textResponse("output-A"),
      textResponse("output-B"),
      textResponse("output-C"),
    ]);

    const graph = new TuttiGraph(
      {
        entrypoint: "A",
        nodes: [
          { id: "A", agent: agent("A") },
          { id: "B", agent: agent("B") },
          { id: "C", agent: agent("C") },
        ],
        edges: [
          { from: "A", to: "B" },
          { from: "B", to: "C" },
          { from: "C", to: END },
        ],
      },
      runner,
    );

    const result = await graph.run("start");

    expect(result.path).toEqual(["A", "B", "C"]);
    expect(result.final_output).toBe("output-C");
    expect(result.outputs["A"]?.output).toBe("output-A");
    expect(result.outputs["B"]?.output).toBe("output-B");
    expect(result.outputs["C"]?.output).toBe("output-C");
    expect(result.total_usage.input_tokens).toBeGreaterThan(0);
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("feeds each node the previous node's output as input", async () => {
    // We verify by checking the mock provider received the right messages.
    // Node B should receive "output-A" as its input.
    const provider = createMockProvider([
      textResponse("output-A"),
      textResponse("output-B"),
    ]);
    const events = new EventBus();
    const sessions = new InMemorySessionStore();
    const runner = new AgentRunner(provider, events, sessions);

    const graph = new TuttiGraph(
      {
        entrypoint: "A",
        nodes: [
          { id: "A", agent: agent("A") },
          { id: "B", agent: agent("B") },
        ],
        edges: [
          { from: "A", to: "B" },
          { from: "B", to: END },
        ],
      },
      runner,
    );

    await graph.run("hello");

    // Second call to provider.chat should have "output-A" as the user message
    const secondCall = provider.chat.mock.calls[1]?.[0];
    const userMsg = secondCall?.messages?.[0];
    expect(userMsg?.content).toBe("output-A");
  });
});

// ─────────────────────────────────────────────────────────────────
// 2. Conditional branch: router → A or B depending on output
// ─────────────────────────────────────────────────────────────────
describe("TuttiGraph — conditional branch", () => {
  it("follows the first matching conditional edge", async () => {
    const runner = createRunner([
      textResponse("route:B"),   // router says "route:B"
      textResponse("output-B"),  // B runs
    ]);

    const graph = new TuttiGraph(
      {
        entrypoint: "router",
        nodes: [
          { id: "router", agent: agent("router") },
          { id: "A", agent: agent("A") },
          { id: "B", agent: agent("B") },
        ],
        edges: [
          {
            from: "router",
            to: "A",
            condition: (r: NodeResult) => r.output.includes("route:A"),
            label: "to-A",
          },
          {
            from: "router",
            to: "B",
            condition: (r: NodeResult) => r.output.includes("route:B"),
            label: "to-B",
          },
          { from: "A", to: END },
          { from: "B", to: END },
        ],
      },
      runner,
    );

    const result = await graph.run("decide");

    expect(result.path).toEqual(["router", "B"]);
    expect(result.final_output).toBe("output-B");
  });

  it("goes to END when no edge condition matches", async () => {
    const runner = createRunner([
      textResponse("no-match"),
    ]);

    const graph = new TuttiGraph(
      {
        entrypoint: "router",
        nodes: [
          { id: "router", agent: agent("router") },
          { id: "A", agent: agent("A") },
        ],
        edges: [
          {
            from: "router",
            to: "A",
            condition: (r: NodeResult) => r.output.includes("go-A"),
          },
          // No fallback unconditional edge — should implicitly end
          { from: "A", to: END },
        ],
      },
      runner,
    );

    const result = await graph.run("decide");

    expect(result.path).toEqual(["router"]);
    expect(result.final_output).toBe("no-match");
  });

  it("takes an unconditional edge as fallback", async () => {
    const runner = createRunner([
      textResponse("anything"),
      textResponse("fallback-output"),
    ]);

    const graph = new TuttiGraph(
      {
        entrypoint: "router",
        nodes: [
          { id: "router", agent: agent("router") },
          { id: "A", agent: agent("A") },
          { id: "fallback", agent: agent("fallback") },
        ],
        edges: [
          {
            from: "router",
            to: "A",
            condition: (r: NodeResult) => r.output === "NEVER",
          },
          { from: "router", to: "fallback" }, // unconditional
          { from: "A", to: END },
          { from: "fallback", to: END },
        ],
      },
      runner,
    );

    const result = await graph.run("input");

    expect(result.path).toEqual(["router", "fallback"]);
    expect(result.final_output).toBe("fallback-output");
  });
});

// ─────────────────────────────────────────────────────────────────
// 3. Loop with max iterations
// ─────────────────────────────────────────────────────────────────
describe("TuttiGraph — loop with max iterations", () => {
  it("loops a node until the exit condition is met", async () => {
    // Refine loops back to itself twice, then exits to END on the 3rd visit
    const runner = createRunner([
      textResponse("draft-1"),  // refine visit 1
      textResponse("draft-2"),  // refine visit 2
      textResponse("approved"), // refine visit 3 → exits
    ]);

    const graph = new TuttiGraph(
      {
        entrypoint: "refine",
        nodes: [
          { id: "refine", agent: agent("refine") },
        ],
        edges: [
          {
            from: "refine",
            to: "refine",
            condition: (r: NodeResult) => !r.output.includes("approved"),
            label: "needs-work",
          },
          {
            from: "refine",
            to: END,
            condition: (r: NodeResult) => r.output.includes("approved"),
            label: "done",
          },
        ],
      },
      runner,
    );

    const result = await graph.run("initial draft");

    expect(result.path).toEqual(["refine", "refine", "refine"]);
    expect(result.final_output).toBe("approved");
  });

  it("throws GraphCycleError when max_node_visits is exceeded", async () => {
    // Always loops — never satisfies exit condition
    const runner = createRunner(
      Array.from({ length: 10 }, (_, i) => textResponse(`attempt-${i}`)),
    );

    const graph = new TuttiGraph(
      {
        entrypoint: "stuck",
        nodes: [
          { id: "stuck", agent: agent("stuck") },
        ],
        edges: [
          { from: "stuck", to: "stuck" }, // unconditional self-loop
        ],
      },
      runner,
    );

    await expect(
      graph.run("start", { max_node_visits: 3 }),
    ).rejects.toThrow(GraphCycleError);
  });

  it("respects a custom max_node_visits value", async () => {
    const runner = createRunner(
      Array.from({ length: 3 }, () => textResponse("again")),
    );

    const graph = new TuttiGraph(
      {
        entrypoint: "looper",
        nodes: [
          { id: "looper", agent: agent("looper") },
        ],
        edges: [
          { from: "looper", to: "looper" },
        ],
      },
      runner,
    );

    await expect(
      graph.run("go", { max_node_visits: 2 }),
    ).rejects.toThrow(GraphCycleError);
  });
});

// ─────────────────────────────────────────────────────────────────
// 4. Parallel branches + merge
// ─────────────────────────────────────────────────────────────────
describe("TuttiGraph — parallel + merge", () => {
  it("runs parallel branches concurrently and merges at the merge node", async () => {
    const runner = createRunner([
      textResponse("route-output"),  // router
      textResponse("branch-A"),      // A (parallel)
      textResponse("branch-B"),      // B (parallel)
      textResponse("merged-result"), // merge node
    ]);

    const graph = new TuttiGraph(
      {
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
      },
      runner,
    );

    const result = await graph.run("start");

    // Path includes router, then both parallel branches, then merge
    expect(result.path).toContain("router");
    expect(result.path).toContain("A");
    expect(result.path).toContain("B");
    expect(result.path).toContain("merge");
    expect(result.final_output).toBe("merged-result");

    // Both branch outputs should be in the results
    expect(result.outputs["A"]?.output).toBe("branch-A");
    expect(result.outputs["B"]?.output).toBe("branch-B");
    expect(result.outputs["merge"]?.output).toBe("merged-result");
  });

  it("passes concatenated parallel outputs to the merge node", async () => {
    const provider = createMockProvider([
      textResponse("routed"),
      textResponse("from-X"),
      textResponse("from-Y"),
      textResponse("final"),
    ]);
    const events = new EventBus();
    const sessions = new InMemorySessionStore();
    const runner = new AgentRunner(provider, events, sessions);

    const graph = new TuttiGraph(
      {
        entrypoint: "router",
        nodes: [
          { id: "router", agent: agent("router") },
          { id: "X", agent: agent("X") },
          { id: "Y", agent: agent("Y") },
          { id: "merger", agent: agent("merger"), merge: true },
        ],
        edges: [
          { from: "router", to: "X", parallel: true },
          { from: "router", to: "Y", parallel: true },
          { from: "X", to: "merger" },
          { from: "Y", to: "merger" },
          { from: "merger", to: END },
        ],
      },
      runner,
    );

    await graph.run("go");

    // The merge node (4th call) should receive concatenated branch outputs
    const mergeCall = provider.chat.mock.calls[3]?.[0];
    const mergeInput = mergeCall?.messages?.[0]?.content as string;
    expect(mergeInput).toContain("[from: X]");
    expect(mergeInput).toContain("from-X");
    expect(mergeInput).toContain("[from: Y]");
    expect(mergeInput).toContain("from-Y");
  });
});

// ─────────────────────────────────────────────────────────────────
// 5. Streaming events
// ─────────────────────────────────────────────────────────────────
describe("TuttiGraph — stream()", () => {
  it("yields events in execution order", async () => {
    const runner = createRunner([
      textResponse("A-out"),
      textResponse("B-out"),
    ]);

    const graph = new TuttiGraph(
      {
        entrypoint: "A",
        nodes: [
          { id: "A", agent: agent("A") },
          { id: "B", agent: agent("B") },
        ],
        edges: [
          { from: "A", to: "B" },
          { from: "B", to: END },
        ],
      },
      runner,
    );

    const events: GraphEvent[] = [];
    for await (const event of graph.stream("input")) {
      events.push(event);
    }

    const types = events.map((e) => e.type);
    expect(types[0]).toBe("graph:start");
    expect(types).toContain("node:start");
    expect(types).toContain("node:end");
    expect(types).toContain("edge:traverse");
    expect(types[types.length - 1]).toBe("graph:end");
  });
});

// ─────────────────────────────────────────────────────────────────
// 6. Shared state
// ─────────────────────────────────────────────────────────────────
describe("TuttiGraph — shared state", () => {
  it("passes initial_state through and returns final_state", async () => {
    const runner = createRunner([
      textResponse("done"),
    ]);

    const StateSchema = z.object({
      counter: z.number().default(0),
    });

    const graph = new TuttiGraph(
      {
        entrypoint: "A",
        nodes: [{ id: "A", agent: agent("A") }],
        edges: [{ from: "A", to: END }],
        state: StateSchema,
      },
      runner,
    );

    const result = await graph.run("go", {
      initial_state: { counter: 42 },
    });

    expect(result.final_state).toEqual({ counter: 42 });
  });
});
