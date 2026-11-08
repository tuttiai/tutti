import { describe, expect, it } from "vitest";
import type { ScoreConfig } from "@tuttiai/types";

import { findDelegationCycle, nestedDelegators, validateDelegationGraph } from "../../src/delegation/delegation-graph.js";

function agents(graph: Record<string, string[] | undefined>): ScoreConfig["agents"] {
  return Object.fromEntries(
    Object.entries(graph).map(([id, delegates]) => [
      id,
      { name: id, system_prompt: id, voices: [], ...(delegates ? { delegates } : {}) },
    ]),
  );
}

const graphOf = (g: Record<string, string[]>): Map<string, string[]> => new Map(Object.entries(g));

describe("nestedDelegators", () => {
  it("lists the non-entry agents that have delegates, in score order", () => {
    expect(nestedDelegators(agents({ orch: ["a"], a: ["b"], b: undefined, c: [], d: ["b"] }), "orch")).toEqual(["a", "d"]);
  });

  it("returns nothing when only the entry delegates", () => {
    expect(nestedDelegators(agents({ orch: ["a"], a: undefined }), "orch")).toEqual([]);
  });
});

describe("findDelegationCycle", () => {
  it("finds no cycle in a tree", () => {
    expect(findDelegationCycle(graphOf({ orch: ["a", "b"], a: ["c"], b: ["c"], c: [] }))).toBeUndefined();
  });

  it("finds a two-agent cycle", () => {
    expect(findDelegationCycle(graphOf({ a: ["b"], b: ["a"] }))).toEqual(["a", "b", "a"]);
  });

  it("finds a cycle back to the entry agent", () => {
    expect(findDelegationCycle(graphOf({ orch: ["a"], a: ["b"], b: ["orch"] }))).toEqual(["orch", "a", "b", "orch"]);
  });

  it("finds an agent that delegates to itself", () => {
    expect(findDelegationCycle(graphOf({ a: ["a"] }))).toEqual(["a", "a"]);
  });

  it("ignores ids missing from the graph", () => {
    expect(findDelegationCycle(graphOf({ a: ["ghost"] }))).toBeUndefined();
  });
});

describe("validateDelegationGraph", () => {
  it("accepts a two-level tree", () => {
    expect(() => validateDelegationGraph(agents({ orch: ["a"], a: ["b"], b: undefined }))).not.toThrow();
  });

  it("refuses an unknown delegate id, naming it and the available agents", () => {
    expect(() => validateDelegationGraph(agents({ orch: ["a"], a: ["ghost"] }))).toThrow(
      'nested_delegation: agent "a" delegates to unknown agent "ghost". Available: orch, a',
    );
  });

  it("refuses a cycle, naming it with a fix hint", () => {
    expect(() => validateDelegationGraph(agents({ orch: ["a"], a: ["b"], b: ["a"] }))).toThrow(
      /delegation cycle a -> b -> a\. Remove one of these delegates\[\] entries, or turn nested_delegation off\./,
    );
  });
});
