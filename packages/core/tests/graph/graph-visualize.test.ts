import { describe, it, expect } from "vitest";
import { renderGraph, graphToJSON } from "../../src/graph/visualize.js";
import { END } from "../../src/graph/types.js";
import type { AgentConfig } from "@tuttiai/types";
import type { GraphConfig } from "../../src/graph/types.js";

function agent(name: string): AgentConfig {
  return {
    name,
    model: "test-model",
    system_prompt: `You are ${name}.`,
    voices: [],
  };
}

function threeNodeGraph(): GraphConfig {
  return {
    entrypoint: "planner",
    nodes: [
      { id: "planner", agent: agent("planner") },
      { id: "coder", agent: agent("coder") },
      { id: "qa", agent: agent("qa") },
    ],
    edges: [
      { from: "planner", to: "coder" },
      { from: "coder", to: "qa" },
      { from: "qa", to: END },
    ],
  };
}

describe("renderGraph", () => {
  it("returns an HTML string containing all three node IDs", () => {
    const html = renderGraph(threeNodeGraph());

    expect(html).toContain("planner");
    expect(html).toContain("coder");
    expect(html).toContain("qa");
  });

  it("contains the static SVG in a <noscript> block", () => {
    const html = renderGraph(threeNodeGraph());

    expect(html).toContain("<noscript>");
    expect(html).toContain("<svg");
    expect(html).toContain("</svg>");
  });

  it("includes the END node when edges target __end__", () => {
    const html = renderGraph(threeNodeGraph());

    expect(html).toContain("__end__");
  });

  it("embeds graph data as JSON for D3 to consume", () => {
    const html = renderGraph(threeNodeGraph());

    expect(html).toContain('id="graph-data"');
    expect(html).toContain('"entrypoint":"planner"');
  });

  it("loads D3 from CDN", () => {
    const html = renderGraph(threeNodeGraph());

    expect(html).toContain("d3@7");
  });

  it("includes edge labels when present", () => {
    const config: GraphConfig = {
      entrypoint: "A",
      nodes: [
        { id: "A", agent: agent("A") },
        { id: "B", agent: agent("B") },
      ],
      edges: [
        { from: "A", to: "B", label: "next-step" },
        { from: "B", to: END },
      ],
    };

    const html = renderGraph(config);
    expect(html).toContain("next-step");
  });
});

describe("graphToJSON", () => {
  it("returns a serialisable object with nodes and edges", () => {
    const json = graphToJSON(threeNodeGraph());

    expect(json["entrypoint"]).toBe("planner");
    expect(json["has_state"]).toBe(false);

    const nodes = json["nodes"] as Array<{ id: string }>;
    const nodeIds = nodes.map((n) => n.id);
    expect(nodeIds).toContain("planner");
    expect(nodeIds).toContain("coder");
    expect(nodeIds).toContain("qa");
    expect(nodeIds).toContain("__end__");

    const edges = json["edges"] as Array<{ source: string; target: string }>;
    expect(edges).toHaveLength(3);
    expect(edges[0]).toEqual(
      expect.objectContaining({ source: "planner", target: "coder" }),
    );
  });
});
