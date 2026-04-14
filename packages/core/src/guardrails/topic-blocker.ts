/**
 * Built-in guardrail: blocks output whose content is too similar to
 * a set of forbidden topics.
 *
 * Uses a lightweight bag-of-words cosine similarity approach — no
 * external embeddings required. Each blocked topic is converted to a
 * term-frequency vector; the output text is compared against every
 * topic vector. If any cosine similarity exceeds the threshold
 * (default 0.85) the guardrail throws {@link GuardrailError}.
 */

import type { GuardrailHook } from "@tuttiai/types";
import { GuardrailError } from "../errors.js";

const DEFAULT_THRESHOLD = 0.85;

export interface TopicBlockerOptions {
  /** Similarity threshold (0–1). Default 0.85. */
  threshold?: number;
}

/** Tokenise text into lowercase alphanumeric terms. */
function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/** Build a term-frequency map from a list of tokens. */
function termFrequency(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const t of tokens) {
    tf.set(t, (tf.get(t) ?? 0) + 1);
  }
  return tf;
}

/** Cosine similarity between two term-frequency vectors. */
function cosineSimilarity(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (const [term, freqA] of a) {
    normA += freqA * freqA;
    const freqB = b.get(term);
    if (freqB !== undefined) {
      dot += freqA * freqB;
    }
  }

  for (const freqB of b.values()) {
    normB += freqB * freqB;
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}

/**
 * Creates a guardrail hook that blocks output matching blocked topics.
 *
 * @param blockedTopics - Phrase strings describing forbidden topics.
 * @param options - Optional threshold override.
 * @returns A {@link GuardrailHook} suitable for {@link AgentConfig.afterRun}.
 *
 * @example
 * const agent: AgentConfig = {
 *   // ...
 *   afterRun: topicBlocker(["how to make explosives", "illegal drug synthesis"]),
 * };
 */
export function topicBlocker(
  blockedTopics: string[],
  options: TopicBlockerOptions = {},
): GuardrailHook {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const topicVectors = blockedTopics.map((topic) => ({
    topic,
    tf: termFrequency(tokenize(topic)),
  }));

  return async (text: string): Promise<string> => {
    const textTf = termFrequency(tokenize(text));

    for (const { topic, tf } of topicVectors) {
      const score = cosineSimilarity(textTf, tf);
      if (score > threshold) {
        throw new GuardrailError(
          `Output blocked: content is too similar to forbidden topic "${topic}" (score: ${score.toFixed(2)}).`,
          { guardrail: "topic_blocker", topic, score },
        );
      }
    }

    return text;
  };
}
