import type { ScorerRef } from "../golden/types.js";
import { CustomScorer } from "./custom.js";
import { ExactScorer } from "./exact.js";
import { SimilarityScorer, type EmbeddingsClient } from "./similarity.js";
import { ToolSequenceScorer } from "./tool-sequence.js";
import type { Scorer } from "./types.js";

/**
 * Construction-time overrides for the built-in scorers. Primarily exists
 * so tests can inject a fake OpenAI embeddings client without hitting
 * the network.
 */
export interface ScorerRegistryOptions {
  /** Override the embeddings client used by {@link SimilarityScorer}. */
  embeddingsClient?: EmbeddingsClient;
}

/**
 * Turn a {@link ScorerRef} from a `GoldenCase` into a concrete
 * {@link Scorer} instance. Unknown types fail loud — the set of
 * built-ins is fixed, and misspellings would otherwise silently drop
 * the scorer from the run.
 *
 * `threshold` is passed through to {@link SimilarityScorer} only (the
 * other built-ins don't use it). `path` is required for `"custom"` and
 * rejected for the built-ins.
 */
export function resolveScorer(
  ref: ScorerRef,
  options: ScorerRegistryOptions = {},
): Scorer {
  switch (ref.type) {
    case "exact":
      return new ExactScorer();

    case "tool-sequence":
      return new ToolSequenceScorer();

    case "similarity":
      return new SimilarityScorer({
        ...(ref.threshold !== undefined ? { threshold: ref.threshold } : {}),
        ...(options.embeddingsClient !== undefined
          ? { client: options.embeddingsClient }
          : {}),
      });

    case "custom": {
      if (!ref.path || ref.path.trim() === "") {
        throw new Error(
          "resolveScorer: custom scorer requires a module path on ScorerRef.path",
        );
      }
      return new CustomScorer(ref.path);
    }

    default: {
      // Runtime guard for values smuggled in via `as unknown`.
      const kind = (ref as { type: string }).type;
      throw new Error("resolveScorer: unknown scorer type '" + kind + "'");
    }
  }
}
