import { printablePath } from "./report.js";

/**
 * One history finding. Only a SHA, a path or a pull request number is kept: never a diff line,
 * blob content or commit message, so nothing a finding prints can carry a payload.
 */
export type HistoryFinding =
  | {
      /** Rule (a): a merge commit added lines found in neither parent to a `.config.` file. */
      readonly rule: "a";
      /** The merge commit's full SHA. */
      readonly sha: string;
      /** The file, relative to the repository root, as git names it. */
      readonly path: string;
    }
  | {
      /** Rule (b): a merged pull request's frozen head is not an ancestor of the ref. */
      readonly rule: "b";
      /** The pull request head's full SHA. */
      readonly sha: string;
      /** The pull request number. */
      readonly pr: number;
    };

function detail(finding: HistoryFinding): string {
  return finding.rule === "a" ? finding.path : String(finding.pr).padStart(10, "0");
}

/**
 * Orders findings by rule, then SHA, then path or pull request number.
 *
 * @param findings - Findings in any order.
 * @returns A sorted copy.
 */
export function sortHistoryFindings(findings: readonly HistoryFinding[]): HistoryFinding[] {
  const key = (finding: HistoryFinding): string => `${finding.rule}\u0000${finding.sha}\u0000${detail(finding)}`;
  return [...findings].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

/**
 * Formats one finding as `history (a) <sha> <path>` or `history (b) <sha> PR #<n>`. The path
 * goes through {@link printablePath}, since whoever committed it chose its name.
 *
 * @param finding - The finding to format.
 * @returns One output line, without a newline.
 */
export function formatHistoryFinding(finding: HistoryFinding): string {
  if (finding.rule === "a") return `history (a) ${finding.sha} ${printablePath(finding.path)}`;
  return `history (b) ${finding.sha} PR #${String(finding.pr)}`;
}

/**
 * The count line after the findings.
 *
 * @param findings - Every finding.
 * @returns `check:history: <F> finding(s): <A> rule (a), <B> rule (b)`.
 */
export function historyFailureSummary(findings: readonly HistoryFinding[]): string {
  const a = findings.filter((finding) => finding.rule === "a").length;
  const counts = `${String(a)} rule (a), ${String(findings.length - a)} rule (b)`;
  return `check:history: ${String(findings.length)} finding(s): ${counts}`;
}

/**
 * The single line a clean run prints.
 *
 * @param merges - How many merge commits rule (a) scanned.
 * @param pulls - How many merged pull request heads rule (b) checked.
 * @returns `check:history: OK, <M> merges scanned, <P> pull requests checked, no findings`.
 */
export function historyCleanSummary(merges: number, pulls: number): string {
  return `check:history: OK, ${String(merges)} merges scanned, ${String(pulls)} pull requests checked, no findings`;
}
