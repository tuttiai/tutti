import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  SimilarityScorer,
  cosineSimilarity,
  DEFAULT_SIMILARITY_THRESHOLD,
  type EmbeddingsClient,
} from "../../../src/eval/scorers/similarity.js";
import type { ScorerInput } from "../../../src/eval/scorers/types.js";

// ---------------------------------------------------------------------------
// Fake embeddings client — records calls + yields fixed vectors per input.
// ---------------------------------------------------------------------------

function fixedClient(responses: Record<string, number[]>): EmbeddingsClient & {
  calls: Array<{ model: string; input: string[] }>;
} {
  const calls: Array<{ model: string; input: string[] }> = [];
  return {
    calls,
    create: async ({ model, input }) => {
      calls.push({ model, input });
      const data = input.map((s) => {
        const vec = responses[s];
        if (!vec) throw new Error("fixedClient has no vector for: " + JSON.stringify(s));
        return { embedding: vec };
      });
      return { data };
    },
  };
}

function mkInput(output: string, expected_output?: string): ScorerInput {
  return {
    input: "ignored",
    output,
    tool_sequence: [],
    ...(expected_output !== undefined ? { expected_output } : {}),
  };
}

/* ========================================================================= */
/*  cosineSimilarity                                                          */
/* ========================================================================= */

describe("cosineSimilarity", () => {
  it("is 1 for identical vectors", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBe(1);
    expect(cosineSimilarity([3, 4], [3, 4])).toBeCloseTo(1, 9);
  });
  it("is 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
  });
  it("is -1 for opposite vectors", () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBe(-1);
  });
  it("is invariant to positive scaling", () => {
    expect(cosineSimilarity([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 9);
  });
  it("returns 0 for zero-magnitude input", () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
  it("returns 0 when the vectors have different lengths", () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });
});

/* ========================================================================= */
/*  SimilarityScorer                                                          */
/* ========================================================================= */

describe("SimilarityScorer", () => {
  // Snapshot + restore OPENAI_API_KEY around each test — several cases
  // depend on whether it's set and we don't want to leak across tests.
  const original = process.env.OPENAI_API_KEY;
  beforeEach(() => {
    delete process.env.OPENAI_API_KEY;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = original;
  });

  it("passes and detail='skipped' when OPENAI_API_KEY is unset and no client is injected", async () => {
    const scorer = new SimilarityScorer();
    const r = await scorer.score(mkInput("whatever", "something else"));
    expect(r.score).toBe(0);
    expect(r.passed).toBe(true); // skip does not fail the overall run
    expect(r.detail).toMatch(/OPENAI_API_KEY/);
  });

  it("returns passed:false when expected_output is missing", async () => {
    const client = fixedClient({});
    const scorer = new SimilarityScorer({ client });
    const r = await scorer.score(mkInput("x"));
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/expected_output/);
  });

  it("scores 1.0 / passed:true when both outputs embed to the same vector", async () => {
    const client = fixedClient({
      hello: [1, 0, 0],
      hi: [1, 0, 0],
    });
    const scorer = new SimilarityScorer({ client });
    const r = await scorer.score(mkInput("hello", "hi"));
    expect(r.score).toBeCloseTo(1, 9);
    expect(r.passed).toBe(true);
  });

  it("passes when cosine is above the default 0.85 threshold", async () => {
    // Two vectors with cosine ≈ 0.96 — well above 0.85.
    const client = fixedClient({
      out: [1, 0.3, 0],
      exp: [1, 0.1, 0],
    });
    const scorer = new SimilarityScorer({ client });
    const r = await scorer.score(mkInput("out", "exp"));
    expect(r.score).toBeGreaterThan(DEFAULT_SIMILARITY_THRESHOLD);
    expect(r.passed).toBe(true);
  });

  it("fails with detail when cosine is below the threshold", async () => {
    // cosine ≈ 0.707 against threshold 0.85 → fail.
    const client = fixedClient({
      out: [1, 0, 0],
      exp: [1, 1, 0],
    });
    const scorer = new SimilarityScorer({ client });
    const r = await scorer.score(mkInput("out", "exp"));
    expect(r.passed).toBe(false);
    expect(r.score).toBeCloseTo(Math.SQRT1_2, 6);
    expect(r.detail).toMatch(/cosine.*below threshold/);
  });

  it("respects a custom threshold", async () => {
    const client = fixedClient({
      out: [1, 0, 0],
      exp: [1, 1, 0],
    });
    // cosine ≈ 0.707 — below 0.85 but well above 0.5.
    const strict = new SimilarityScorer({ client, threshold: 0.85 });
    const lenient = new SimilarityScorer({ client, threshold: 0.5 });
    expect((await strict.score(mkInput("out", "exp"))).passed).toBe(false);
    expect((await lenient.score(mkInput("out", "exp"))).passed).toBe(true);
  });

  it("sends both texts through the embedding API with the configured model", async () => {
    const client = fixedClient({
      foo: [1, 0],
      bar: [0, 1],
    });
    const scorer = new SimilarityScorer({ client, model: "custom-model" });
    await scorer.score(mkInput("foo", "bar"));
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]!.model).toBe("custom-model");
    expect(client.calls[0]!.input).toEqual(["foo", "bar"]);
  });

  it("returns passed:false with an error detail when the embedding call throws", async () => {
    const client: EmbeddingsClient = {
      create: () => Promise.reject(new Error("rate limited")),
    };
    const scorer = new SimilarityScorer({ client });
    const r = await scorer.score(mkInput("a", "b"));
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/embedding request failed.*rate limited/);
  });
});
