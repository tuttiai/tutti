import { GitError, gitOk } from "./git.js";
import type { GitRunner } from "./git.js";
import type { HistoryFinding } from "./history-report.js";

/** The fetch that brings every pull request's head into a clone. The script itself never fetches. */
export const PULL_REFSPEC = "git fetch origin '+refs/pull/*/head:refs/pull/*/head'";

/** What rule (b) found, and how much it looked at. */
export interface PullScan {
  /** One finding per merged pull request whose head is not an ancestor of the ref. */
  readonly findings: readonly HistoryFinding[];
  /** How many merged pull requests had a head to check. */
  readonly checked: number;
  /** How many merged pull requests had no `refs/pull/<n>/head` in this clone. */
  readonly missing: number;
  /** True when pull requests were merged but the clone holds no pull ref at all. */
  readonly noRefs: boolean;
}

const MERGE_SUBJECT = /^Merge pull request #(\d+) from /;
const PULL_REF = /^refs\/pull\/(\d+)\/head$/;

/**
 * The pull request numbers named by GitHub's merge subjects, `Merge pull request #<n> from ...`.
 * A squash or rebase merge has no such subject and is not named. The subjects are read here
 * and never kept or printed.
 *
 * @param subjects - One subject per line, as `git log --format=%s` prints them.
 * @returns Each number once, in the order first seen.
 */
export function mergedPullNumbers(subjects: string): number[] {
  const numbers = new Set<number>();
  for (const subject of subjects.split("\n")) {
    const match = MERGE_SUBJECT.exec(subject);
    if (match?.[1] !== undefined) numbers.add(Number(match[1]));
  }
  return [...numbers];
}

/**
 * Reads `for-each-ref --format=%(refname)%00%(objectname)` output into a map from pull request
 * number to the head SHA its `refs/pull/<n>/head` points at. Other refs are ignored.
 *
 * @param listing - The listing, one `<ref>\0<sha>` per line.
 * @returns Head SHA by pull request number.
 */
export function parsePullRefs(listing: string): Map<number, string> {
  const heads = new Map<number, string>();
  for (const line of listing.split("\n")) {
    const [ref = "", sha = ""] = line.split("\0");
    const match = PULL_REF.exec(ref);
    if (match?.[1] !== undefined && sha !== "") heads.set(Number(match[1]), sha);
  }
  return heads;
}

async function isAncestor(git: GitRunner, sha: string, head: string): Promise<boolean> {
  const result = await git.run(["merge-base", "--is-ancestor", "--end-of-options", sha, head]);
  if (result.code === 0 || result.code === 1) return result.code === 0;
  throw new GitError("merge-base", result.code);
}

async function listInputs(git: GitRunner, head: string): Promise<{ merged: number[]; heads: Map<number, string> }> {
  const subjects = await gitOk(git, ["log", "--first-parent", "--merges", "--format=%s", "--end-of-options", head]);
  const listing = await gitOk(git, ["for-each-ref", "--format=%(refname)%00%(objectname)", "refs/pull/"]);
  return { merged: mergedPullNumbers(subjects), heads: parsePullRefs(listing) };
}

/**
 * Rule (b): every pull request merged into the ref (by its first-parent merge subjects) whose
 * frozen `refs/pull/<n>/head` is not an ancestor of the ref. A rewrite of the ref keeps the
 * merge subjects but cannot move GitHub's pull refs, so the heads it dropped show here.
 *
 * @param git - The runner.
 * @param head - The full SHA of the commit whose history is checked.
 * @returns The findings, how many heads were checked, and how many were missing.
 * @throws {GitError} When a git call fails.
 */
export async function scanPulls(git: GitRunner, head: string): Promise<PullScan> {
  const { merged, heads } = await listInputs(git, head);
  const findings: HistoryFinding[] = [];
  let checked = 0;
  for (const pr of merged) {
    const sha = heads.get(pr);
    if (sha === undefined) continue;
    checked += 1;
    if (!(await isAncestor(git, sha, head))) findings.push({ rule: "b", sha, pr });
  }
  const missing = merged.length - checked;
  return { findings, checked, missing, noRefs: merged.length > 0 && heads.size === 0 };
}

/**
 * The line that says rule (b) could not check every merged pull request, naming the fetch that
 * fixes it.
 *
 * @param scan - What rule (b) found.
 * @returns The line, or null when every merged pull request had a head to check.
 */
export function describeGap(scan: PullScan): string | null {
  if (scan.noRefs) return `check:history: no refs/pull/*/head in this clone, so rule (b) checked nothing; run ${PULL_REFSPEC}`;
  if (scan.missing === 0) return null;
  return `check:history: missing=${String(scan.missing)}, merged pull requests with no refs/pull/<n>/head; run ${PULL_REFSPEC}`;
}
