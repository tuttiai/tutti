import { describe, it, expect, expectTypeOf } from "vitest";
import { defineGraph } from "../../src/graph/dsl.js";
import { END } from "../../src/graph/types.js";
import type { GraphEvent } from "../../src/graph/types.js";
import { GraphValidationError } from "../../src/graph/errors.js";
import type { WaitNode } from "../../src/index.js";
import { agent, configWith, construct, gate } from "./wait-fixtures.js";

describe("wait node: happy path", () => {
  it.each([
    ["event only", gate()],
    ["event and match", gate({ match: { status: "paid" } })],
    ["event and timeout", gate({ timeout: { after_ms: 60_000, to: "done" } })],
    [
      "all fields",
      gate({
        match: { order: { currency: "EUR" } },
        timeout: { after_ms: 1, to: END },
        description: "Wait for payment",
      }),
    ],
  ])("accepts %s", (_name, wait) => {
    expect(() => construct(configWith([wait]))).not.toThrow();
  });
});

describe("wait node: edge cases accepted", () => {
  it.each([
    ["an empty match", gate({ match: {} })],
    ["a nested match", gate({ match: { a: { b: [1, { c: null }] }, ok: true } })],
    ["an event name with dots", gate({ event: "order.paid.v2" })],
    ["an event name with colons", gate({ event: "user:signup" })],
    ["a timeout branch to itself", gate({ timeout: { after_ms: 5, to: "gate" } })],
    ["a very long timeout", gate({ timeout: { after_ms: 30 * 24 * 3_600_000, to: "done" } })],
  ])("accepts %s", (_name, wait) => {
    expect(() => construct(configWith([wait]))).not.toThrow();
  });

  it("accepts an empty waits array, and the graph still runs", async () => {
    const config = { ...configWith([]), edges: [{ from: "start", to: END }] };
    config.nodes = [{ id: "start", agent: agent("start") }];
    const result = await construct(config).run("go");
    expect(result.path).toEqual(["start"]);
  });

  it("accepts a timeout branch to a node added after the wait, and a wait as last node", () => {
    const config = defineGraph("start")
      .node("start", agent("start"))
      .wait("gate", "order.paid", { timeout: { after_ms: 10, to: "late" } })
      .node("late", agent("late"))
      .edge("start", "gate")
      .edge("late", END)
      .edge("gate", END)
      .build();
    expect(() => construct(config)).not.toThrow();
  });
});

describe("GraphBuilder.wait", () => {
  it("adds a wait node with kind and options", () => {
    const config = defineGraph("start")
      .node("start", agent("start"))
      .wait("gate", "order.paid", { match: { id: 1 }, description: "pay" })
      .edge("start", "gate")
      .edge("gate", END)
      .build();
    const expected: WaitNode = {
      kind: "wait",
      id: "gate",
      event: "order.paid",
      match: { id: 1 },
      description: "pay",
    };
    expect(config.waits).toEqual([expected]);
  });

  it("leaves build() output unchanged when no wait is declared", () => {
    const a = agent("a");
    const config = defineGraph("a").node("a", a).edge("a", END).build();
    expect(config).toStrictEqual({
      entrypoint: "a",
      nodes: [{ id: "a", agent: a, description: undefined, merge: undefined }],
      edges: [{ from: "a", to: END, condition: undefined, label: undefined, parallel: undefined }],
    });
    expect("waits" in config).toBe(false);
  });

  it("copies the waits array so later calls do not change a built config", () => {
    const builder = defineGraph("s").node("s", agent("s")).wait("w", "e");
    const first = builder.build();
    builder.wait("w2", "e");
    expect(first.waits).toHaveLength(1);
  });
});

describe("GraphEvent: waiting and resumed", () => {
  it("type-checks both events as GraphEvent and narrows on type", () => {
    const waiting: GraphEvent = {
      type: "node:waiting",
      node_id: "gate",
      wait_id: "w-1",
      event: "order.paid",
      match: { status: "paid" },
      timeout_at: 1_700_000_000_000,
      session_id: "s-1",
    };
    const resumed: GraphEvent = {
      type: "node:resumed",
      node_id: "gate",
      wait_id: "w-1",
      event: "order.paid",
      reason: "event",
      payload: { status: "paid" },
      waited_ms: 12,
      next_node_id: "done",
    };
    const seen: string[] = [];
    for (const e of [waiting, resumed]) {
      if (e.type === "node:waiting") {
        expectTypeOf(e.timeout_at).toEqualTypeOf<number | undefined>();
        seen.push(e.wait_id);
      }
      if (e.type === "node:resumed") {
        expectTypeOf(e.reason).toEqualTypeOf<"event" | "timeout">();
        seen.push(e.next_node_id);
      }
    }
    expect(seen).toEqual(["w-1", "done"]);
  });
});

describe("run guard", () => {
  it("run() refuses a graph that declares wait nodes", async () => {
    const graph = construct(configWith([gate()]));
    await expect(graph.run("go")).rejects.toThrow(GraphValidationError);
    await expect(graph.run("go")).rejects.toThrow(/experimental/);
  });

  it("stream() refuses a graph that declares wait nodes", async () => {
    const graph = construct(configWith([gate()]));
    const iterator = graph.stream("go")[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toThrow(GraphValidationError);
  });
});
