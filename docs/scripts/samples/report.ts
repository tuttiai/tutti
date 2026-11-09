import type { SkipEntry, Verdict } from "./skip-list.js";
import type { SampleDiagnostic, SampleKey } from "./types.js";

/** Where output goes. The entry wires these to stdout and stderr; tests capture them. */
export interface Writer {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

/** Exit code when every sample type-checks or is skipped, and every skip-list entry is needed. */
export const EXIT_PASS = 0;
/** Exit code when a sample fails and is not skipped, or a skip-list entry now passes or is stale. */
export const EXIT_FAIL = 1;
/** Exit code when the check could not run: no build, a bad skip list, no samples, global errors. */
export const EXIT_INCOMPLETE = 2;

/** The prefix on every line the checker writes. */
export const PREFIX = "docs:check-samples";

/**
 * One diagnostic as `file:line:col TS<code> <message>`, with line and column in the .mdx file.
 *
 * @param file - The .mdx path relative to the repository root.
 * @param diagnostic - The placed diagnostic.
 * @returns The line to print.
 */
export function formatDiagnostic(file: string, diagnostic: SampleDiagnostic): string {
  return `${file}:${diagnostic.line}:${diagnostic.column} TS${diagnostic.code} ${diagnostic.message}`;
}

/**
 * A sample key as a reader would look for it, and as it goes in the skip list.
 *
 * @param key - The file, heading and index.
 * @returns For example `docs/x.mdx (heading "setup", index 2)`.
 */
export function describeKey(key: SampleKey): string {
  return `${key.file} (heading "${key.heading}", index ${key.index})`;
}

function entryLines(verdict: Verdict): string[] {
  const describe = (entry: SkipEntry, what: string): string => `${describeKey(entry)}: ${what}`;
  return [
    ...verdict.nowPasses.map((entry) => describe(entry, "now passes, remove from skip list")),
    ...verdict.stale.map((entry) => describe(entry, "stale entry, no such block")),
  ];
}

/**
 * Writes every unskipped failure, every skip-list entry that now passes or is stale, and the
 * summary line, and works out the exit code.
 *
 * @param write - Where to write.
 * @param verdict - The results sorted against the skip list.
 * @param checked - How many samples were checked.
 * @returns {@link EXIT_PASS} or {@link EXIT_FAIL}.
 */
export function report(write: Writer, verdict: Verdict, checked: number): number {
  for (const result of verdict.failures) {
    for (const diagnostic of result.diagnostics) write.err(formatDiagnostic(result.sample.file, diagnostic));
    write.err(`${describeKey(result.sample)}: fails and is not in the skip list`);
  }
  const entries = entryLines(verdict);
  for (const line of entries) write.err(line);
  const failed = verdict.failures.length;
  const counts = `${verdict.passed} passed, ${verdict.skipped.length} skipped, ${failed} failed, ${entries.length} stale`;
  const summary = `${PREFIX}: ${checked} checked, ${counts}`;
  if (failed + entries.length === 0) {
    write.out(summary);
    return EXIT_PASS;
  }
  write.err(summary);
  return EXIT_FAIL;
}
