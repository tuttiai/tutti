/**
 * Types for the golden-dataset evaluation layer.
 *
 * A "golden case" is a pinned example — an input the agent should still
 * handle the same way months from now. A "golden run" is one recorded
 * execution of a case: its scorer verdicts are what CI regression checks
 * assert against. Both are stored by {@link GoldenStore} implementations.
 *
 * @module
 */

/**
 * Pointer to a scorer that a {@link GoldenCase} wants to run against every
 * recorded {@link GoldenRun}.
 *
 * `threshold` is interpreted by the scorer itself — e.g. `similarity` treats
 * it as a minimum cosine score in `[0, 1]`, `exact` ignores it. `path` is
 * used by `type: "custom"` to locate a user-provided scorer module.
 */
export interface ScorerRef {
  /** Built-in scorer kind, or `"custom"` for a user-provided module. */
  type: "exact" | "similarity" | "tool-sequence" | "custom";
  /** Optional pass/fail cutoff — meaning depends on the scorer. */
  threshold?: number;
  /** Module path for `type: "custom"`. Ignored by built-in scorers. */
  path?: string;
}

/**
 * One scorer's verdict for a single {@link GoldenRun}. Runners aggregate
 * these into the run's `scores` map keyed by scorer name.
 */
export interface ScoreResult {
  /** Human-readable scorer identifier (e.g. `"exact"`, `"similarity"`). */
  scorer: string;
  /** Numeric score in `[0, 1]`. `1` = perfect, `0` = total miss. */
  score: number;
  /** Whether the score cleared the scorer's threshold. */
  passed: boolean;
  /** Optional human-readable explanation (diff hint, top-k ids, etc.). */
  detail?: string;
}

/**
 * A pinned regression case. Captured either by promoting a production
 * session (`promoted_from_session`) or authored by hand.
 *
 * `id` is assigned by the store on save — callers may leave it blank for
 * fresh cases. The `expected_*` fields are all optional; which ones are
 * populated depends on the scorers the case declares.
 */
export interface GoldenCase {
  /**
   * Stable identifier — assigned by the store on `saveCase` when blank.
   * The codebase uses `randomUUID` from `node:crypto` for this class of id;
   * the spec mentioned nanoid but we follow the existing convention.
   */
  id: string;
  /** Human label shown in reports, e.g. `"summarize Q1 report"`. */
  name: string;
  /** Agent key from the score file this case should run against. */
  agent_id: string;
  /** Input message sent to the agent on every run. */
  input: string;
  /** Optional exact-match target for the agent's text output. */
  expected_output?: string;
  /** Expected ordered sequence of tool names called during the run. */
  expected_tool_sequence?: string[];
  /** Expected structured payload when the agent uses an `outputSchema`. */
  expected_structured?: unknown;
  /** Which scorers the runner should apply to every run of this case. */
  scorers: ScorerRef[];
  /** Free-form tags for filtering (`"regression"`, `"smoke"`, ...). */
  tags?: string[];
  /** Session id the case was promoted from, when applicable. */
  promoted_from_session?: string;
  /** Wall-clock time the case was pinned. */
  created_at: Date;
}

/**
 * One recorded execution of a {@link GoldenCase}. The runner persists these
 * so CI can compare the latest run against historical baselines and flag
 * regressions (`passed: true → false`).
 */
export interface GoldenRun {
  /**
   * Stable identifier — assigned by the store on `saveRun` when blank.
   * See the note on {@link GoldenCase.id}.
   */
  id: string;
  /** Case id this run belongs to. Never changes after save. */
  case_id: string;
  /** Wall-clock time the run completed. */
  ran_at: Date;
  /** Text output from the agent. */
  output: string;
  /** Structured payload, when the case's agent uses an `outputSchema`. */
  structured?: unknown;
  /** Ordered tool names called during the run. */
  tool_sequence: string[];
  /** Total tokens (input + output) consumed by the run. */
  tokens: number;
  /** Estimated USD cost of the run, when pricing is available. */
  cost_usd?: number;
  /** Scorer verdicts keyed by scorer name — `scores["exact"]`, etc. */
  scores: Record<string, ScoreResult>;
  /** Overall pass state — `true` iff every scorer passed. */
  passed: boolean;
  /** Optional text diff of `output` vs `case.expected_output`. */
  diff?: string;
}
