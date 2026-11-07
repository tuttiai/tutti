import { GitError, isShallow, resolveCommit } from "./git.js";
import type { GitRunner } from "./git.js";
import { HISTORY_USAGE, parseHistoryArgs } from "./history-args.js";
import type { HistoryArgs } from "./history-args.js";
import { scanMerges } from "./history-merges.js";
import type { MergeScan } from "./history-merges.js";
import { describeGap, scanPulls } from "./history-pulls.js";
import type { PullScan } from "./history-pulls.js";
import {
  formatHistoryFinding,
  historyCleanSummary,
  historyFailureSummary,
  sortHistoryFindings,
} from "./history-report.js";
import { EXIT_CLEAN, EXIT_FINDINGS, EXIT_INCOMPLETE } from "./run.js";
import type { Writer } from "./run.js";

/** What `runHistory` needs. */
export interface HistoryRunOptions {
  /** The git calls to use. */
  readonly git: GitRunner;
  /** The command-line arguments after the script name. */
  readonly argv: readonly string[];
  /** Where to write findings and the summary. */
  readonly write: Writer;
}

interface Outcome {
  readonly merges: MergeScan;
  readonly pulls: PullScan;
}

// Findings win over a gap in rule (b), as they do in check:integrity: a finding is never hidden.
function conclude(write: Writer, outcome: Outcome): number {
  const findings = [...outcome.merges.findings, ...outcome.pulls.findings];
  for (const finding of sortHistoryFindings(findings)) write.err(formatHistoryFinding(finding));
  const gap = describeGap(outcome.pulls);
  if (gap !== null) write.err(gap);
  if (findings.length > 0) {
    write.err(historyFailureSummary(findings));
    return EXIT_FINDINGS;
  }
  if (gap !== null) return EXIT_INCOMPLETE;
  write.out(historyCleanSummary(outcome.merges.merges, outcome.pulls.checked));
  return EXIT_CLEAN;
}

async function check(git: GitRunner, args: HistoryArgs, write: Writer): Promise<number> {
  if (await isShallow(git)) {
    write.err("check:history: the clone is shallow, so its history cannot be checked; run git fetch --unshallow");
    return EXIT_INCOMPLETE;
  }
  const head = await resolveCommit(git, args.ref);
  if (head === null) {
    write.err("check:history: --ref names no commit in this clone; with no local main, pass --ref=origin/main");
    return EXIT_INCOMPLETE;
  }
  const merges = await scanMerges(git, { head, since: args.since });
  return conclude(write, { merges, pulls: await scanPulls(git, head) });
}

/**
 * Checks the history of a ref, writes the findings and a summary, and returns the exit code.
 * Rule (a) looks at merges since `--since`; rule (b) at every merged pull request, whatever
 * `--since` says. A refused option, a shallow clone, an unknown ref, a failed git call or
 * merged pull requests with no head to check (when nothing was found) gives
 * {@link EXIT_INCOMPLETE}, naming the git subcommand and its exit code, never what git printed.
 * An error that is not a {@link GitError} is not caught: the entry reports it.
 *
 * @param options - The runner, the arguments and the writer.
 * @returns {@link EXIT_CLEAN}, {@link EXIT_FINDINGS} or {@link EXIT_INCOMPLETE}.
 */
export async function runHistory(options: HistoryRunOptions): Promise<number> {
  const parsed = parseHistoryArgs(options.argv);
  if (!parsed.ok) {
    options.write.err(`check:history: ${parsed.reason}`);
    options.write.err(HISTORY_USAGE);
    return EXIT_INCOMPLETE;
  }
  try {
    return await check(options.git, parsed.args, options.write);
  } catch (error: unknown) {
    if (!(error instanceof GitError)) throw error;
    options.write.err(`check:history: ${error.message}`);
    return EXIT_INCOMPLETE;
  }
}
