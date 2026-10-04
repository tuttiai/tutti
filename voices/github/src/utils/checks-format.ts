import { truncate } from "./format.js";

/** How one check run or commit status counts towards the overall result. */
export type CheckBucket = "passed" | "failed" | "pending" | "skipped";

/** The fields of a check run that `list_pull_request_checks` reports. */
export interface CheckRunSummary {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  html_url: string | null;
  output: { title: string | null; summary: string | null };
  app?: { slug?: string } | null;
}

/** The fields of a commit status that `list_pull_request_checks` reports. */
export interface CommitStatusSummary {
  context: string;
  state: string;
  description: string | null;
  target_url: string | null;
}

/** Conclusions that mean the check did not pass and the change needs attention. */
const FAILED_CONCLUSIONS = new Set([
  "failure",
  "timed_out",
  "cancelled",
  "action_required",
  "startup_failure",
  "stale",
]);

const TITLE_MAX = 120;
const SUMMARY_MAX = 300;

/**
 * Decide which bucket a check run falls in.
 *
 * Anything not yet `completed` is pending. A completed run passes on
 * `success`, fails on any conclusion in {@link FAILED_CONCLUSIONS}, and is
 * counted as skipped otherwise (`neutral`, `skipped`).
 *
 * @param run - The check run's `status` and `conclusion`.
 * @returns The bucket the run counts towards.
 */
export function checkRunBucket(run: Pick<CheckRunSummary, "status" | "conclusion">): CheckBucket {
  if (run.status !== "completed") return "pending";
  if (run.conclusion === "success") return "passed";
  if (run.conclusion !== null && FAILED_CONCLUSIONS.has(run.conclusion)) return "failed";
  return "skipped";
}

/**
 * Decide which bucket a commit status falls in.
 *
 * @param state - The status's `state`: `success`, `failure`, `error` or `pending`.
 * @returns The bucket the status counts towards.
 */
export function commitStatusBucket(state: string): CheckBucket {
  if (state === "success") return "passed";
  if (state === "failure" || state === "error") return "failed";
  return "pending";
}

/**
 * Count buckets and render the one-line overall result with a verdict.
 *
 * The verdict is `green` only when at least one check exists and none failed
 * or is still running, so an agent gating on it never reads "no CI" as a pass.
 *
 * @param buckets - One bucket per check run and commit status.
 * @returns For example `Overall: 3 passed, 1 failed, 0 pending, 0 skipped (verdict: failing)`.
 */
export function overallLine(buckets: readonly CheckBucket[]): string {
  const count = (b: CheckBucket): number => buckets.filter((x) => x === b).length;
  const [passed, failed, pending, skipped] = [
    count("passed"),
    count("failed"),
    count("pending"),
    count("skipped"),
  ];
  let verdict = "green";
  if (buckets.length === 0) verdict = "no checks";
  else if (failed > 0) verdict = "failing";
  else if (pending > 0) verdict = "pending";
  return `Overall: ${passed} passed, ${failed} failed, ${pending} pending, ${skipped} skipped (verdict: ${verdict})`;
}

/**
 * Render one check run as an indented block of lines.
 *
 * @param run - The check run.
 * @returns Lines naming the run, its result, timings, link, and truncated output.
 */
export function formatCheckRun(run: CheckRunSummary): string[] {
  const result = run.status === "completed" ? (run.conclusion ?? "none") : run.status;
  const lines = [
    `  [${checkRunBucket(run)}] ${run.name}: ${result}  (check_run_id ${run.id}, app ${run.app?.slug ?? "unknown"})`,
    `    Started: ${run.started_at ?? "-"}  Completed: ${run.completed_at ?? "-"}`,
  ];
  if (run.html_url) lines.push(`    URL: ${run.html_url}`);
  if (run.output.title) lines.push(`    Title: ${truncate(run.output.title, TITLE_MAX)}`);
  if (run.output.summary) {
    lines.push(`    Summary: ${truncate(run.output.summary.replace(/\s+/g, " ").trim(), SUMMARY_MAX)}`);
  }
  return lines;
}

/**
 * Render one commit status as a single line.
 *
 * @param status - The commit status.
 * @returns A line naming its context, state, description and link.
 */
export function formatCommitStatus(status: CommitStatusSummary): string {
  const description = status.description ? ` - ${truncate(status.description, TITLE_MAX)}` : "";
  const url = status.target_url ? `  ${status.target_url}` : "";
  return `  [${commitStatusBucket(status.state)}] ${status.context}: ${status.state}${description}${url}`;
}
