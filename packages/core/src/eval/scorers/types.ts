/**
 * Shared types for the built-in golden scorers.
 *
 * A scorer reads an immutable {@link ScorerInput} and emits a
 * {@link ScoreResult}. The runner passes the same input to every scorer
 * attached to a case and stores the verdicts on the resulting
 * `GoldenRun.scores` map.
 *
 * @module
 */

import type { ScoreResult } from "../golden/types.js";

/**
 * Everything a scorer might legitimately compare against. Fields are all
 * optional except `output` / `tool_sequence` (what the agent actually
 * did) — individual scorers decide which expected fields they need and
 * surface a `detail` when a required one is missing.
 */
export interface ScorerInput {
  /** The user message that was sent to the agent. */
  input: string;
  /** The agent's text output for this run. */
  output: string;
  /** Ordered tool calls the agent made during this run. */
  tool_sequence: string[];
  /** Structured output payload, when the agent uses an `outputSchema`. */
  structured?: unknown;
  /** Expected text output (exact / similarity scorers). */
  expected_output?: string;
  /** Expected tool call sequence (tool-sequence scorer). */
  expected_tool_sequence?: string[];
  /** Expected structured payload. */
  expected_structured?: unknown;
}

/**
 * Pluggable scorer interface. Implementations MUST:
 *
 * - be pure relative to the input (no hidden state between calls);
 * - never throw — signal failure via `{ passed: false, detail }`;
 * - return a `scorer` name that uniquely identifies the scorer kind so
 *   runners can key the result on it. The built-in scorers use the
 *   `ScorerRef.type` string verbatim (`"exact"`, `"similarity"`,
 *   `"tool-sequence"`). Custom scorers suffix their module path.
 */
export interface Scorer {
  readonly name: string;
  score(input: ScorerInput): Promise<ScoreResult>;
}
