import { describe, it, expect } from "vitest";
import { defineGraph, GraphBuilder } from "../../src/graph/dsl.js";
import { END } from "../../src/graph/types.js";
import type { AgentConfig } from "@tuttiai/types";
import type { NodeResult } from "../../src/graph/types.js";

function agent(name: string): AgentConfig {
  return {
    name,
    model: "test-model",
    system_prompt: `You are ${name}.`,
    voices: [],
  };
}

describe("GraphBuilder", () => {
  it("builds a valid GraphConfig from the fluent API", () => {
    const config = defineGraph("planner")
      .node("planner", agent("planner"))
      .node("coder", agent("coder"))
      .node("qa", agent("qa"))
      .edge("planner", "coder")
      .edge("coder", "qa")
      .edge("qa", END, { label: "approved" })
      .build();

    expect(config.entrypoint).toBe("planner");
    expect(config.nodes).toHaveLength(3);
    expect(config.edges).toHaveLength(3);
    expect(config.nodes[0]?.id).toBe("planner");
    expect(config.edges[2]?.label).toBe("approved");
  });

  it("supports conditional edges", () => {
    const condition = (r: NodeResult): boolean => r.output.includes("fix");
    const config = defineGraph("qa")
      .node("qa", agent("qa"))
      .node("coder", agent("coder"))
      .edge("qa", "coder", { condition, label: "retry" })
      .edge("qa", END)
      .edge("coder", "qa")
      .build();

    expect(config.edges[0]?.condition).toBe(condition);
    expect(config.edges[0]?.label).toBe("retry");
  });

  it("supports parallel and merge options", () => {
    const config = defineGraph("router")
      .node("router", agent("router"))
      .node("a", agent("a"))
      .node("b", agent("b"))
      .node("merge", agent("merge"), { merge: true })
      .edge("router", "a", { parallel: true })
      .edge("router", "b", { parallel: true })
      .edge("a", "merge")
      .edge("b", "merge")
      .edge("merge", END)
      .build();

    expect(config.edges[0]?.parallel).toBe(true);
    expect(config.nodes[3]?.merge).toBe(true);
  });

  it("supports a state schema", async () => {
    const { z } = await import("zod");
    const schema = z.object({ count: z.number() });

    const config = defineGraph("start")
      .node("start", agent("start"))
      .edge("start", END)
      .state(schema)
      .build();

    expect(config.state).toBe(schema);
  });

  it("returns a new config object on each build() call", () => {
    const builder = defineGraph("a").node("a", agent("a")).edge("a", END);
    const c1 = builder.build();
    const c2 = builder.build();
    expect(c1).not.toBe(c2);
    expect(c1.nodes).not.toBe(c2.nodes);
  });
});
