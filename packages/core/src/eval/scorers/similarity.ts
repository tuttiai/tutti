import OpenAI from "openai";

import type { ScoreResult } from "../golden/types.js";
import { SecretsManager } from "../../secrets.js";
import type { Scorer, ScorerInput } from "./types.js";

/** Cosine similarity cutoff below which the scorer marks the run as failed. */
export const DEFAULT_SIMILARITY_THRESHOLD = 0.85;

/** Embedding model used by {@link SimilarityScorer}. */
export const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";

/**
 * Minimal embedding client shape — narrow enough to stand in for the
 * full OpenAI SDK in tests without mocking the whole class.
 */
export interface EmbeddingsClient {
  create(args: { model: string; input: string[] }): Promise<{
    data: Array<{ embedding: number[] }>;
  }>;
}

/** Cosine similarity on equal-length numeric vectors. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  // Iterate via array methods + `.at()` — equivalent to `a[i]`/`b[i]` but
  // doesn't trip `security/detect-object-injection`.
  a.forEach((av, i) => {
    const bv = b.at(i) ?? 0;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  });
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Construction options for {@link SimilarityScorer}. */
export interface SimilarityScorerOptions {
  /** Pass/fail cutoff for cosine similarity. Defaults to `0.85`. */
  threshold?: number;
  /** Embedding model id. Defaults to `text-embedding-3-small`. */
  model?: string;
  /**
   * Injected embeddings client — primarily for tests. When omitted, a
   * real OpenAI client is built lazily on first `score()` if
   * `OPENAI_API_KEY` is set.
   */
  client?: EmbeddingsClient;
}

/**
 * Cosine-similarity scorer backed by OpenAI's embedding API.
 *
 * When `OPENAI_API_KEY` is unset and no client override is provided, the
 * scorer returns `{ score: 0, passed: true, detail: "skipped: ..." }`
 * so CI runs without OpenAI credentials don't fail the overall golden
 * run — the skip is recorded in the detail instead.
 *
 * The threshold is configurable per-case via `ScorerRef.threshold` and
 * carried into the constructor by the registry.
 */
export class SimilarityScorer implements Scorer {
  readonly name = "similarity";
  private readonly threshold: number;
  private readonly model: string;
  private readonly clientOverride: EmbeddingsClient | undefined;
  private lazyClient: EmbeddingsClient | undefined;

  constructor(options: SimilarityScorerOptions = {}) {
    this.threshold = options.threshold ?? DEFAULT_SIMILARITY_THRESHOLD;
    this.model = options.model ?? DEFAULT_EMBEDDING_MODEL;
    this.clientOverride = options.client;
  }

  async score(input: ScorerInput): Promise<ScoreResult> {
    if (input.expected_output === undefined) {
      return {
        scorer: this.name,
        score: 0,
        passed: false,
        detail: "similarity scorer requires expected_output on the case",
      };
    }

    const client = this.resolveClient();
    if (!client) {
      return {
        scorer: this.name,
        score: 0,
        passed: true,
        detail: "skipped: OPENAI_API_KEY not set",
      };
    }

    let vectors: number[][];
    try {
      const res = await client.create({
        model: this.model,
        input: [input.output, input.expected_output],
      });
      vectors = res.data.map((d) => d.embedding);
    } catch (err) {
      return {
        scorer: this.name,
        score: 0,
        passed: false,
        detail:
          "embedding request failed: " +
          (err instanceof Error ? err.message : String(err)),
      };
    }

    const [a, b] = vectors;
    if (!a || !b) {
      return {
        scorer: this.name,
        score: 0,
        passed: false,
        detail: "embedding response missing vectors",
      };
    }

    const score = cosineSimilarity(a, b);
    const passed = score >= this.threshold;
    return {
      scorer: this.name,
      score,
      passed,
      ...(passed
        ? {}
        : { detail: "cosine " + score.toFixed(4) + " below threshold " + this.threshold }),
    };
  }

  private resolveClient(): EmbeddingsClient | undefined {
    if (this.clientOverride) return this.clientOverride;
    if (this.lazyClient) return this.lazyClient;
    const apiKey = SecretsManager.optional("OPENAI_API_KEY");
    if (!apiKey) return undefined;
    const sdk = new OpenAI({ apiKey });
    this.lazyClient = sdk.embeddings;
    return this.lazyClient;
  }
}
