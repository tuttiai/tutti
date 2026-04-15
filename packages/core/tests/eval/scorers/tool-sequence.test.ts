import { describe, expect, it } from "vitest";

import {
  countOrderedMatches,
  ToolSequenceScorer,
} from "../../../src/eval/scorers/tool-sequence.js";
import type { ScorerInput } from "../../../src/eval/scorers/types.js";

function mkInput(
  tool_sequence: string[],
  expected_tool_sequence: string[] | undefined,
): ScorerInput {
  return {
    input: "irrelevant",
    output: "",
    tool_sequence,
    ...(expected_tool_sequence !== undefined ? { expected_tool_sequence } : {}),
  };
}

describe("countOrderedMatches", () => {
  it("matches an identical sequence completely", () => {
    expect(countOrderedMatches(["a", "b", "c"], ["a", "b", "c"])).toBe(3);
  });
  it("matches when actual has extras between / around expected", () => {
    expect(countOrderedMatches(["a", "b"], ["x", "a", "y", "b", "z"])).toBe(2);
  });
  it("counts only the matches that appear in order", () => {
    expect(countOrderedMatches(["a", "b", "c"], ["a", "c", "b"])).toBe(2);
  });
  it("returns 0 when none of expected appear", () => {
    expect(countOrderedMatches(["a", "b"], ["x", "y"])).toBe(0);
  });
  it("returns 0 when expected is empty (caller handles the all-pass case)", () => {
    expect(countOrderedMatches([], ["a", "b"])).toBe(0);
  });
  it("tolerates duplicate tool names by advancing one match at a time", () => {
    expect(countOrderedMatches(["a", "a"], ["a", "a", "a"])).toBe(2);
    expect(countOrderedMatches(["a", "a"], ["a", "b"])).toBe(1);
  });
});

describe("ToolSequenceScorer", () => {
  const scorer = new ToolSequenceScorer();

  it("reports scorer name verbatim", () => {
    expect(scorer.name).toBe("tool-sequence");
  });

  it("scores 1.0 / passed:true on an identical sequence", async () => {
    const r = await scorer.score(mkInput(["search", "fetch"], ["search", "fetch"]));
    expect(r.score).toBe(1);
    expect(r.passed).toBe(true);
  });

  it("passes when expected appears in order with extras around it", async () => {
    const r = await scorer.score(
      mkInput(["warm_cache", "search", "log", "fetch", "cleanup"], ["search", "fetch"]),
    );
    expect(r.score).toBe(1);
    expect(r.passed).toBe(true);
  });

  it("returns partial credit when not every expected tool appears", async () => {
    const r = await scorer.score(mkInput(["search"], ["search", "fetch"]));
    expect(r.score).toBe(0.5);
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/1\/2/);
  });

  it("fails when expected tools appear out of order", async () => {
    // "search" first, but the scorer then looks for "fetch" after index 0 —
    // "fetch" appears at index 1, so both match. Flip the order to force a
    // failure: expected=[fetch, search] against actual=[search, fetch].
    const r = await scorer.score(mkInput(["search", "fetch"], ["fetch", "search"]));
    expect(r.passed).toBe(false);
    expect(r.score).toBe(0.5);
  });

  it("returns 1.0 / passed:true when expected is empty", async () => {
    const r = await scorer.score(mkInput(["anything"], []));
    expect(r.score).toBe(1);
    expect(r.passed).toBe(true);
  });

  it("returns 0 / passed:false when no expected tool appears", async () => {
    const r = await scorer.score(mkInput(["other"], ["search", "fetch"]));
    expect(r.score).toBe(0);
    expect(r.passed).toBe(false);
  });

  it("returns passed:false with detail when expected_tool_sequence is missing", async () => {
    const r = await scorer.score(mkInput(["search"], undefined));
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/expected_tool_sequence/);
  });
});
