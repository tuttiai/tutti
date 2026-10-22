import { describe, expect, it } from "vitest";

import { buildGraph, identWeight } from "../src/repo-map/graph.js";
import type { Focus } from "../src/repo-map/graph.js";
import { personalisedPageRank } from "../src/repo-map/pagerank.js";
import { rankDefinitions } from "../src/repo-map/rank.js";
import { estimateTokens, renderMap } from "../src/repo-map/render.js";
import { HUB_AND_LEAVES, MANY_DEFINITIONS, SELF_REFERENCING } from "./fixtures/repo-map/graphs.js";

const NO_FOCUS: Focus = { files: new Set(), idents: new Set() };

function rank(focus: Focus = NO_FOCUS): Map<string, number> {
  const graph = buildGraph(HUB_AND_LEAVES, focus);
  return personalisedPageRank({
    nodes: HUB_AND_LEAVES.map((f) => f.path),
    edges: graph.edges,
    personalisation: new Map([...focus.files].map((f) => [f, 1])),
  });
}

describe("identWeight", () => {
  it("up-weights long camelCase or snake_case names", () => {
    expect(identWeight("sharedHelper", 1, NO_FOCUS)).toBe(10);
    expect(identWeight("load_records", 1, NO_FOCUS)).toBe(10);
    expect(identWeight("plainword", 1, NO_FOCUS)).toBe(1);
  });

  it("up-weights focused names and down-weights common, short, private and many-defined ones", () => {
    expect(identWeight("plainword", 1, { files: new Set(), idents: new Set(["plainword"]) })).toBe(10);
    expect(identWeight("get", 1, NO_FOCUS)).toBeCloseTo(0.02);
    expect(identWeight("_private", 1, NO_FOCUS)).toBeCloseTo(0.1);
    expect(identWeight("plainword", 6, NO_FOCUS)).toBeCloseTo(0.1);
  });
});

describe("buildGraph", () => {
  it("links each user to the file defining the name, weighted by use", () => {
    const graph = buildGraph(HUB_AND_LEAVES, NO_FOCUS);
    expect(graph.edges.get("a.ts")?.get("hub.ts")).toBeCloseTo(10 * Math.sqrt(2));
    expect(graph.edges.get("b.ts")?.get("leaf.ts")).toBeCloseTo(10);
    expect(graph.edges.has("hub.ts")).toBe(false);
  });

  it("ignores a file's uses of its own names", () => {
    expect(buildGraph(SELF_REFERENCING, NO_FOCUS).edges.size).toBe(0);
  });
});

describe("personalisedPageRank", () => {
  it("returns ranks that sum to 1 and favour the most used file", () => {
    const ranks = rank();
    const total = [...ranks.values()].reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 6);
    const best = [...ranks].sort((x, y) => y[1] - x[1])[0]?.[0];
    expect(best).toBe("hub.ts");
  });

  it("shifts rank towards the personalised files", () => {
    const plain = rank().get("leaf.ts") ?? 0;
    const focused = rank({ files: new Set(["b.ts"]), idents: new Set() }).get("leaf.ts") ?? 0;
    expect(focused).toBeGreaterThan(plain);
  });

  it("handles an empty graph and a graph without edges", () => {
    expect(personalisedPageRank({ nodes: [], edges: new Map() }).size).toBe(0);
    const ranks = personalisedPageRank({ nodes: ["x", "y"], edges: new Map() });
    expect(ranks.get("x")).toBeCloseTo(0.5);
  });
});

describe("rankDefinitions", () => {
  it("puts the most used definition first and unused ones after", () => {
    const graph = buildGraph(HUB_AND_LEAVES, NO_FOCUS);
    const ranked = rankDefinitions(HUB_AND_LEAVES, graph, { ranks: rank(), focus: NO_FOCUS });
    expect(ranked[0]?.definition.name).toBe("sharedHelper");
    const names = ranked.map((r) => r.definition.name);
    expect(names.indexOf("unusedThing")).toBeGreaterThan(names.indexOf("leafWorker"));
  });
});

describe("renderMap", () => {
  const graph = buildGraph(MANY_DEFINITIONS, NO_FOCUS);
  const ranks = personalisedPageRank({ nodes: MANY_DEFINITIONS.map((f) => f.path), edges: graph.edges });
  const ranked = rankDefinitions(MANY_DEFINITIONS, graph, { ranks, focus: NO_FOCUS });

  it("fits as many definitions as the budget allows", () => {
    const shown = [60, 120, 250].map((budget) => {
      const text = renderMap(ranked, budget, { files: 30, notes: [] });
      expect(estimateTokens(text)).toBeLessThanOrEqual(budget);
      return text.split("\n").filter((l) => l.startsWith("  ")).length;
    });
    expect(shown[0]).toBeGreaterThan(0);
    expect(shown[1]).toBeGreaterThan(shown[0] ?? 0);
    expect(shown[2]).toBeGreaterThan(shown[1] ?? 0);
  });

  it("lists each file once with its definitions indented by line", () => {
    const text = renderMap(ranked, 6000, { files: 30, notes: ["[note]"] });
    expect(text).toContain("src/module-3.ts\n  4: export function exportedFunctionNumber3() {");
    expect(text).toContain("[0 files and 0 definitions left out.");
    expect(text.endsWith("[note]")).toBe(true);
  });

  it("still renders the closing line when nothing fits", () => {
    const text = renderMap(ranked, 1, { files: 30, notes: [] });
    expect(text).toMatch(/^\[30 files and 30 definitions left out\./);
  });
});
