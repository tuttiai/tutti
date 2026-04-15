/**
 * Pure rendering + filtering helpers for `tutti-ai eval run`.
 *
 * The string shape lives here so unit tests can cover it without
 * touching the store, the runner, or process.exit. JUnit XML has its
 * own file (`eval-run-junit.ts`); the orchestrating command in
 * `eval-run.ts` stitches them together.
 */

import chalk from "chalk";
import type { GoldenCase, GoldenRun, ScoreResult } from "@tuttiai/core";

/** Max lines of the unified diff rendered inline (CI XML is unbounded). */
export const DIFF_PREVIEW_LINES = 20;

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

/**
 * Narrow a list of cases by optional `id` and `tag` filters. Both
 * filters are ANDed when both are set. `id` matches either the full
 * case id or any prefix (so an 8-char id from `eval list` works).
 */
export function filterCases(
  cases: GoldenCase[],
  filters: { case?: string; tag?: string },
): GoldenCase[] {
  return cases.filter((c) => {
    if (filters.case !== undefined && !c.id.startsWith(filters.case)) return false;
    if (filters.tag !== undefined) {
      const tags = c.tags ?? [];
      if (!tags.includes(filters.tag)) return false;
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// Per-case render
// ---------------------------------------------------------------------------

/** Short `scorer:score` summary for the pass / CI lines. */
function scoreSummary(scores: Record<string, ScoreResult>): string {
  const parts = Object.values(scores).map(
    (s) => s.scorer + ":" + s.score.toFixed(2),
  );
  return parts.length > 0 ? parts.join(", ") : "(no scorers)";
}

/** First failing scorer — drives the `✗` line's "why" suffix. */
export function firstFailure(scores: Record<string, ScoreResult>): ScoreResult | undefined {
  return Object.values(scores).find((s) => !s.passed);
}

/**
 * Truncate a unified diff to {@link DIFF_PREVIEW_LINES} lines, appending
 * a `… (N more lines)` notice when cut. Preserves the leading `---` /
 * `+++` header so reviewers know which side is which even when the body
 * is clipped.
 */
export function truncateDiffPreview(diff: string, maxLines = DIFF_PREVIEW_LINES): string {
  const lines = diff.split("\n");
  if (lines.length <= maxLines) return diff;
  const kept = lines.slice(0, maxLines);
  const dropped = lines.length - maxLines;
  return kept.join("\n") + "\n\u2026 (" + dropped + " more lines)";
}

/** Colored multi-line render of a single case for interactive runs. */
export function renderCaseLine(goldenCase: GoldenCase, run: GoldenRun): string {
  if (run.passed) {
    return (
      chalk.green("\u2713 ") +
      chalk.bold(goldenCase.name) +
      chalk.dim(" \u2014 " + scoreSummary(run.scores))
    );
  }
  const failure = firstFailure(run.scores);
  const why = failure
    ? failure.scorer + (failure.detail ? ": " + failure.detail : " failed")
    : "run failed";
  const head =
    chalk.red("\u2717 ") +
    chalk.bold(goldenCase.name) +
    chalk.dim(" \u2014 " + why);

  if (run.diff) {
    return head + "\n" + chalk.dim(truncateDiffPreview(run.diff));
  }
  return head;
}

/** Single-line plain render used in CI mode (no ANSI, script-friendly). */
export function renderCaseLineCI(goldenCase: GoldenCase, run: GoldenRun): string {
  const status = run.passed ? "PASS" : "FAIL";
  const id8 = goldenCase.id.slice(0, 8);
  const scoreStr = scoreSummary(run.scores);
  const tokens = "tokens=" + run.tokens;
  const cost =
    run.cost_usd !== undefined ? " cost=$" + run.cost_usd.toFixed(4) : "";
  const why =
    !run.passed && firstFailure(run.scores)
      ? " why=" + (firstFailure(run.scores)?.scorer ?? "")
      : "";
  return (
    status +
    " " +
    id8 +
    " " +
    goldenCase.name +
    " [" +
    scoreStr +
    "] " +
    tokens +
    cost +
    why
  );
}

// ---------------------------------------------------------------------------
// Summary footer
// ---------------------------------------------------------------------------

/** Aggregate counters for a full run. */
export interface SummaryStats {
  passed: number;
  failed: number;
  total: number;
  totalTokens: number;
  totalCostUsd: number;
}

/** Compute summary stats from an array of runs. */
export function computeStats(runs: GoldenRun[]): SummaryStats {
  const passed = runs.filter((r) => r.passed).length;
  const totalTokens = runs.reduce((sum, r) => sum + r.tokens, 0);
  const totalCostUsd = runs.reduce((sum, r) => sum + (r.cost_usd ?? 0), 0);
  return {
    passed,
    failed: runs.length - passed,
    total: runs.length,
    totalTokens,
    totalCostUsd,
  };
}

/** One-line summary footer. `colors: false` drops chalk for CI stdout. */
export function renderSummary(stats: SummaryStats, colors: boolean): string {
  const avgTokens =
    stats.total > 0 ? Math.round(stats.totalTokens / stats.total) : 0;
  const passStr = stats.passed + " passed";
  const failStr = stats.failed + " failed";
  const passOut = colors ? chalk.green(passStr) : passStr;
  const failOut = colors && stats.failed > 0 ? chalk.red(failStr) : failStr;
  return (
    passOut +
    ", " +
    failOut +
    " out of " +
    stats.total +
    " cases | avg tokens: " +
    avgTokens +
    " | total cost: $" +
    stats.totalCostUsd.toFixed(2)
  );
}
