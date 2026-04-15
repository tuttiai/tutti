import type { ScoreResult } from "../golden/types.js";
import type { Scorer, ScorerInput } from "./types.js";

/**
 * Lower-case, trim both ends, collapse every internal whitespace run to a
 * single space. This lets `"  Hello\tWorld  "` match `"hello world"` —
 * which is the level of leniency most agent outputs need for identity
 * comparisons. Callers who want byte-for-byte equality should use a
 * custom scorer.
 */
export function normalizeForExactMatch(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Strict exact-match scorer.
 *
 * Returns `1.0` when the normalized output matches the normalized
 * expected output, `0.0` otherwise. `passed === (score === 1)`. Missing
 * `expected_output` surfaces as `passed: false` with a detail message
 * rather than throwing, so a case with the "exact" scorer attached but
 * no expected value still produces a recorded run.
 */
export class ExactScorer implements Scorer {
  readonly name = "exact";

  score(input: ScorerInput): Promise<ScoreResult> {
    if (input.expected_output === undefined) {
      return Promise.resolve({
        scorer: this.name,
        score: 0,
        passed: false,
        detail: "exact scorer requires expected_output on the case",
      });
    }

    const a = normalizeForExactMatch(input.output);
    const b = normalizeForExactMatch(input.expected_output);
    const match = a === b;

    return Promise.resolve({
      scorer: this.name,
      score: match ? 1 : 0,
      passed: match,
      ...(match ? {} : { detail: "outputs differ after normalization" }),
    });
  }
}
