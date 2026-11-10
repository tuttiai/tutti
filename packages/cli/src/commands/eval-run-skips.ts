/**
 * Skip policy for `tutti-ai eval run --fail-on-skip`.
 *
 * A scorer that could not evaluate (for example `similarity` without
 * `OPENAI_API_KEY`) returns `passed: true` with `skipped: true`. These
 * pure helpers count those results and, when the flag is set, turn them
 * into failures on an in-memory copy of the run. The copy is never saved,
 * so the stored dataset keeps the scorer's own verdict.
 */

import type { GoldenRun, ScoreResult } from "@tuttiai/core";

/** Flags that decide whether a finished run should exit non-zero. */
export interface SkipExitFlags {
  ci?: boolean;
  failOnSkip?: boolean;
}

/** Counts that decide whether a finished run should exit non-zero. */
export interface SkipExitCounts {
  failed: number;
  skipped: number;
}

function isSkipped(result: ScoreResult): boolean {
  return result.skipped === true;
}

/** Count every scorer result marked `skipped: true` across all runs. */
export function countSkipped(runs: GoldenRun[]): number {
  return runs.reduce(
    (sum, run) => sum + Object.values(run.scores).filter(isSkipped).length,
    0,
  );
}

/**
 * Apply `--fail-on-skip` to one run. Returns the run itself when
 * `failOnSkip` is false or nothing was skipped. Otherwise returns a copy
 * in which every skipped result has `passed: false` (and keeps
 * `skipped: true`) and the run has `passed: false`. The input is never
 * mutated.
 */
export function applySkipPolicy(run: GoldenRun, failOnSkip: boolean): GoldenRun {
  if (!failOnSkip) return run;
  const entries = Object.entries(run.scores);
  if (!entries.some(([, s]) => isSkipped(s))) return run;
  const scores: Record<string, ScoreResult> = Object.fromEntries(
    entries.map(([key, s]) => [key, isSkipped(s) ? { ...s, passed: false } : s]),
  );
  return { ...run, scores, passed: false };
}

/**
 * The summary line printed after the totals on every run: `Skipped: N`,
 * with ` (failing run: --fail-on-skip)` appended when the flag turned at
 * least one skip into a failure.
 */
export function renderSkippedLine(skipped: number, failOnSkip: boolean): string {
  const suffix = failOnSkip && skipped > 0 ? " (failing run: --fail-on-skip)" : "";
  return "Skipped: " + skipped + suffix;
}

/**
 * Whether `tutti-ai eval run` should exit 1: any failed case in `--ci`
 * mode, or any skipped result when `--fail-on-skip` is set (with or
 * without `--ci`).
 */
export function shouldFailRun(flags: SkipExitFlags, counts: SkipExitCounts): boolean {
  if (flags.ci === true && counts.failed > 0) return true;
  return flags.failOnSkip === true && counts.skipped > 0;
}
