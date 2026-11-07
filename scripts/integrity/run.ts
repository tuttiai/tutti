import { listConfigFiles } from "./discover.js";
import type { ConfigFile, IntegrityFs } from "./discover.js";
import {
  cleanSummary,
  failureSummary,
  formatFinding,
  printablePath,
  sortFindings,
  unreadableSummary,
} from "./report.js";
import { scanText } from "./scan.js";
import type { Finding } from "./types.js";

/** Where output goes. The entry wires these to stdout and stderr; tests capture them. */
export interface Writer {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

/** What `run` needs. */
export interface RunOptions {
  /** Absolute path of the repository root. */
  readonly root: string;
  /** The file-system calls to use. */
  readonly fs: IntegrityFs;
  /** Where to write findings and the summary. */
  readonly write: Writer;
}

/** Exit code when every config file was read and nothing was found. */
export const EXIT_CLEAN = 0;
/** Exit code when anything was found, whether or not every file could be read. */
export const EXIT_FINDINGS = 1;
/** Exit code when nothing was found but the check was incomplete: no files, or unreadable ones. */
export const EXIT_INCOMPLETE = 2;

interface Outcome {
  readonly findings: readonly Finding[];
  readonly unreadable: number;
  readonly total: number;
}

function describeError(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return error instanceof Error ? error.message : "unknown error";
}

async function checkFile(options: RunOptions, file: ConfigFile): Promise<Finding[] | null> {
  if (file.symlink) return [{ path: file.path, line: null, rule: "SYMLINK", length: 0 }];
  try {
    return scanText(file.path, await options.fs.readFile(file.absolute));
  } catch (error: unknown) {
    // The code or message only, never the error object, as the repository's other CLIs do.
    options.write.err(`${printablePath(file.path)}: could not be read (${printablePath(describeError(error))})`);
    return null;
  }
}

function conclude(write: Writer, outcome: Outcome): number {
  for (const finding of sortFindings(outcome.findings)) write.err(formatFinding(finding));
  if (outcome.findings.length > 0) {
    write.err(failureSummary(outcome.findings, outcome.total));
    return EXIT_FINDINGS;
  }
  if (outcome.unreadable > 0) {
    write.err(unreadableSummary(outcome.unreadable, outcome.total));
    return EXIT_INCOMPLETE;
  }
  write.out(cleanSummary(outcome.total));
  return EXIT_CLEAN;
}

/**
 * Finds every config file in scope, scans each, writes the findings and a summary, and returns
 * the exit code. A scan that checked nothing does not pass: no config files gives
 * {@link EXIT_INCOMPLETE}, as does an unreadable file when nothing else was found.
 *
 * @param options - The root, file system and writer.
 * @returns {@link EXIT_CLEAN}, {@link EXIT_FINDINGS} or {@link EXIT_INCOMPLETE}.
 */
export async function run(options: RunOptions): Promise<number> {
  const files = await listConfigFiles(options.root, options.fs);
  if (files.length === 0) {
    options.write.err("check:integrity: no config files found, so nothing was checked");
    return EXIT_INCOMPLETE;
  }
  const findings: Finding[] = [];
  let unreadable = 0;
  for (const file of files) {
    const result = await checkFile(options, file);
    if (result === null) unreadable += 1;
    else findings.push(...result);
  }
  return conclude(options.write, { findings, unreadable, total: files.length });
}
