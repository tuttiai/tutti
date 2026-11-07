import { SAFE_DIFF, gitOk } from "./git.js";
import type { GitRunner } from "./git.js";
import type { HistoryFinding } from "./history-report.js";

/** What rule (a) needs. */
export interface MergeScanOptions {
  /** The full SHA of the commit whose history is scanned. */
  readonly head: string;
  /** Only merges committed on or after this UTC day, or every merge when null. */
  readonly since: string | null;
}

/** What rule (a) found, and how much it looked at. */
export interface MergeScan {
  /** One finding per merge and `.config.` file with lines found in neither parent. */
  readonly findings: readonly HistoryFinding[];
  /** How many merge commits were scanned. */
  readonly merges: number;
}

/**
 * Whether a path's base name contains `.config.`, the card's wording: wider than the file names
 * check:integrity scans, so a renamed or unusual config file is still covered.
 *
 * @param path - A path as git prints it.
 * @returns True for a config file.
 */
export function isConfigPath(path: string): boolean {
  return path.slice(path.lastIndexOf("/") + 1).includes(".config.");
}

/**
 * Counts the lines of a combined diff (`git diff-tree --cc -p`) that are in neither parent:
 * those with a `+` in every parent's column, two for a two-parent merge. A line taken from one
 * parent (` +` or `+ `) is not counted. The width comes from each hunk header (`@@@` for two
 * parents), so octopus merges are counted too. Returns a number only: no line leaves this function.
 *
 * @param diff - The combined diff of one file.
 * @returns How many lines are in neither parent.
 */
export function countNewLines(diff: string): number {
  let parents = 0;
  let count = 0;
  for (const line of diff.split("\n")) {
    const header = /^(@{3,}) /.exec(line);
    if (header?.[1] !== undefined) parents = header[1].length - 1;
    else if (line.startsWith("diff --cc ") || line.startsWith("diff --combined ")) parents = 0;
    else if (parents > 0 && line.startsWith("+".repeat(parents))) count += 1;
  }
  return count;
}

async function listMerges(git: GitRunner, options: MergeScanOptions): Promise<string[]> {
  const since = options.since === null ? [] : [`--since=${options.since}T00:00:00Z`];
  const out = await gitOk(git, ["rev-list", "--merges", ...since, "--end-of-options", options.head]);
  return out.split("\n").filter((sha) => sha !== "");
}

async function configPaths(git: GitRunner, merge: string): Promise<string[]> {
  const args = ["diff-tree", "--cc", "-r", "-z", "--name-only", "--no-commit-id", ...SAFE_DIFF];
  const out = await gitOk(git, [...args, "--end-of-options", merge]);
  return out.split("\0").filter((path) => path !== "" && isConfigPath(path));
}

async function newLines(git: GitRunner, merge: string, path: string): Promise<number> {
  const args = ["diff-tree", "--cc", "-p", "-r", "--no-commit-id", ...SAFE_DIFF];
  // `:(literal)` keeps a path holding `*` or `?` from being read as a glob.
  return countNewLines(await gitOk(git, [...args, "--end-of-options", merge, "--", `:(literal)${path}`]));
}

/**
 * Rule (a): every merge reachable from the head (since the day, when given) whose combined diff
 * adds lines found in neither parent to a `.config.` file. That is content no reviewed branch
 * carried, which is how an altered merge commit hides a payload.
 *
 * @param git - The runner.
 * @param options - The head and the optional day.
 * @returns The findings and the number of merges scanned.
 * @throws {GitError} When a git call fails.
 */
export async function scanMerges(git: GitRunner, options: MergeScanOptions): Promise<MergeScan> {
  const merges = await listMerges(git, options);
  const findings: HistoryFinding[] = [];
  for (const sha of merges) {
    for (const path of await configPaths(git, sha)) {
      if ((await newLines(git, sha, path)) > 0) findings.push({ rule: "a", sha, path });
    }
  }
  return { findings, merges: merges.length };
}
