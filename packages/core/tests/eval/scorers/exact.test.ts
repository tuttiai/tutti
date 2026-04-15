import { describe, expect, it } from "vitest";

import {
  ExactScorer,
  normalizeForExactMatch,
} from "../../../src/eval/scorers/exact.js";
import type { ScorerInput } from "../../../src/eval/scorers/types.js";

function mkInput(output: string, expected_output?: string): ScorerInput {
  return {
    input: "irrelevant",
    output,
    tool_sequence: [],
    ...(expected_output !== undefined ? { expected_output } : {}),
  };
}

describe("normalizeForExactMatch", () => {
  it("trims, lowercases, and collapses whitespace", () => {
    expect(normalizeForExactMatch("  Hello\tWorld  ")).toBe("hello world");
    expect(normalizeForExactMatch("A\n\nB   C")).toBe("a b c");
  });
  it("leaves already-normalized strings alone", () => {
    expect(normalizeForExactMatch("abc")).toBe("abc");
  });
  it("handles the empty string", () => {
    expect(normalizeForExactMatch("")).toBe("");
  });
});

describe("ExactScorer", () => {
  const scorer = new ExactScorer();

  it("scores 1.0 / passed:true when the normalized strings match", async () => {
    const r = await scorer.score(mkInput("Hello, World!", "  hello,\tworld!  "));
    expect(r.score).toBe(1);
    expect(r.passed).toBe(true);
    expect(r.scorer).toBe("exact");
  });

  it("scores 0.0 / passed:false with a detail when the strings differ", async () => {
    const r = await scorer.score(mkInput("goodbye", "hello"));
    expect(r.score).toBe(0);
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/differ/i);
  });

  it("ignores case and whitespace differences", async () => {
    const r = await scorer.score(mkInput("THE QUICK  BROWN fox", "the quick brown fox"));
    expect(r.passed).toBe(true);
  });

  it("returns passed:false with detail when expected_output is missing", async () => {
    const r = await scorer.score(mkInput("anything"));
    expect(r.score).toBe(0);
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/expected_output/);
  });

  it("treats empty-vs-empty as a match", async () => {
    const r = await scorer.score(mkInput("", ""));
    expect(r.passed).toBe(true);
  });

  it("differentiates non-whitespace content even when surrounded by whitespace", async () => {
    const r = await scorer.score(mkInput("  foo  ", "  bar  "));
    expect(r.passed).toBe(false);
  });
});
