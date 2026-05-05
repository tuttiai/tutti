import type { ScoreResult } from "../golden/types.js";
import type { Scorer, ScorerInput } from "./types.js";

/**
 * Count how many items of `expected` appear in `actual` in the same
 * relative order. Extra tools in `actual` between matches are ignored
 * — this is a subsequence check, not a strict prefix / equality check.
 *
 * Exported for unit testing; external callers should use
 * {@link ToolSequenceScorer}.
 */
export function countOrderedMatches(expected: string[], actual: string[]): number {
  let actualIdx = 0;
  let matched = 0;
  for (const want of expected) {
    while (actualIdx < actual.length && actual.at(actualIdx) !== want) {
      actualIdx++;
    }
    if (actualIdx < actual.length) {
      matched++;
      actualIdx++;
    } else {
      break;
    }
  }
  return matched;
}

/**
 * Partial-credit scorer for the tool call path.
 *
 * `score = matched / expected.length` where `matched` is the number of
 * expected tools that appear in `actual` in the correct relative order.
 * `passed` is strict: every expected tool must appear. Extra tools
 * between or around the expected ones do not fail the scorer — the
 * agent is allowed to over-tool as long as the required path is in
 * there.
 *
 * Edge cases:
 * - `expected` empty → `score: 1, passed: true` (nothing required).
 * - `expected_tool_sequence` missing → `passed: false` with detail.
 */
export class ToolSequenceScorer implements Scorer {
  readonly name = "tool-sequence";

  score(input: ScorerInput): Promise<ScoreResult> {
    if (input.expected_tool_sequence === undefined) {
      return Promise.resolve({
        scorer: this.name,
        score: 0,
        passed: false,
        detail: "tool-sequence scorer requires expected_tool_sequence on the case",
      });
    }

    const expected = input.expected_tool_sequence;
    const actual = input.tool_sequence;

    if (expected.length === 0) {
      return Promise.resolve({ scorer: this.name, score: 1, passed: true });
    }

    const matched = countOrderedMatches(expected, actual);
    const score = matched / expected.length;
    const passed = matched === expected.length;

    return Promise.resolve({
      scorer: this.name,
      score,
      passed,
      ...(passed
        ? {}
        : {
          detail:
            "missing expected tool(s): matched " +
            matched +
            "/" +
            expected.length +
            ". expected=[" +
            expected.join(", ") +
            "] actual=[" +
            actual.join(", ") +
            "]",
        }),
    });
  }
}
