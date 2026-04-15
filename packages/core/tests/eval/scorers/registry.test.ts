import { describe, expect, it } from "vitest";

import { CustomScorer } from "../../../src/eval/scorers/custom.js";
import { ExactScorer } from "../../../src/eval/scorers/exact.js";
import { resolveScorer } from "../../../src/eval/scorers/registry.js";
import {
  SimilarityScorer,
  type EmbeddingsClient,
} from "../../../src/eval/scorers/similarity.js";
import { ToolSequenceScorer } from "../../../src/eval/scorers/tool-sequence.js";

const stubClient: EmbeddingsClient = {
  create: () => Promise.resolve({ data: [{ embedding: [1] }, { embedding: [1] }] }),
};

describe("resolveScorer", () => {
  it("returns an ExactScorer for type: 'exact'", () => {
    const s = resolveScorer({ type: "exact" });
    expect(s).toBeInstanceOf(ExactScorer);
    expect(s.name).toBe("exact");
  });

  it("returns a ToolSequenceScorer for type: 'tool-sequence'", () => {
    const s = resolveScorer({ type: "tool-sequence" });
    expect(s).toBeInstanceOf(ToolSequenceScorer);
    expect(s.name).toBe("tool-sequence");
  });

  it("returns a SimilarityScorer for type: 'similarity', passing through threshold + injected client", async () => {
    const s = resolveScorer(
      { type: "similarity", threshold: 0.5 },
      { embeddingsClient: stubClient },
    );
    expect(s).toBeInstanceOf(SimilarityScorer);
    // Score something with cosine 1 — passes because threshold was plumbed.
    const r = await s.score({
      input: "",
      output: "a",
      tool_sequence: [],
      expected_output: "b",
    });
    expect(r.passed).toBe(true);
    expect(r.score).toBeCloseTo(1, 9);
  });

  it("returns a CustomScorer for type: 'custom' when path is set", () => {
    const s = resolveScorer({ type: "custom", path: "./scorers/foo.mjs" });
    expect(s).toBeInstanceOf(CustomScorer);
    expect(s.name).toBe("custom:./scorers/foo.mjs");
  });

  it("throws for type: 'custom' when path is missing or blank", () => {
    expect(() => resolveScorer({ type: "custom" })).toThrow(/requires a module path/);
    expect(() => resolveScorer({ type: "custom", path: "   " })).toThrow(
      /requires a module path/,
    );
  });

  it("throws for an unknown scorer type", () => {
    // Simulate an unknown kind smuggled in via `as unknown`.
    const ref = { type: "weird" } as unknown as Parameters<typeof resolveScorer>[0];
    expect(() => resolveScorer(ref)).toThrow(/unknown scorer type 'weird'/);
  });
});
