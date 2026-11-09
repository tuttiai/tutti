import { join } from "node:path";
import { compileSamples } from "./compile.js";
import type { TypeScript } from "./compile.js";
import { listMdxFiles, missingBuilds } from "./discover.js";
import type { SamplesFs } from "./discover.js";
import { extractSamples } from "./extract.js";
import { EXIT_INCOMPLETE, PREFIX, report } from "./report.js";
import type { Writer } from "./report.js";
import { applySkipList, parseSkipList } from "./skip-list.js";
import type { SkipEntry } from "./skip-list.js";
import type { Sample } from "./types.js";

/** The checked-in skip list, relative to the repository root. */
export const SKIP_LIST = "docs/code-samples.skip.json";

/** What `run` needs. */
export interface RunOptions {
  /** Absolute path of the repository root. */
  readonly root: string;
  /** The file-system calls to use. */
  readonly fs: SamplesFs;
  /** Where to write diagnostics and the summary. */
  readonly write: Writer;
  /** The TypeScript module to check with. */
  readonly ts: TypeScript;
}

function describeError(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return error instanceof Error ? error.message : "unknown error";
}

async function loadSkipList(options: RunOptions): Promise<readonly SkipEntry[] | null> {
  let text: string;
  try {
    text = await options.fs.readFile(join(options.root, SKIP_LIST));
  } catch (error: unknown) {
    options.write.err(`${PREFIX}: ${SKIP_LIST} could not be read (${describeError(error)})`);
    return null;
  }
  const parsed = parseSkipList(text);
  if (parsed.ok) return parsed.entries;
  for (const problem of parsed.errors) options.write.err(`${PREFIX}: ${SKIP_LIST}: ${problem}`);
  return null;
}

async function collectSamples(options: RunOptions): Promise<Sample[]> {
  const samples: Sample[] = [];
  for (const file of await listMdxFiles(options.root, options.fs)) {
    samples.push(...extractSamples(file, await options.fs.readFile(join(options.root, file))));
  }
  return samples;
}

function incomplete(write: Writer, ...lines: readonly string[]): number {
  for (const line of lines) write.err(`${PREFIX}: ${line}`);
  return EXIT_INCOMPLETE;
}

/**
 * Checks every ts/tsx code block in docs/**\/*.mdx against the built workspace packages, sorts
 * the results against the skip list, writes what fails and a summary, and returns the exit code.
 * A run that could not check does not pass: unbuilt workspaces, an unreadable or invalid skip
 * list, no samples at all and global compiler errors each give {@link EXIT_INCOMPLETE}.
 *
 * @param options - The root, file system, writer and TypeScript module.
 * @returns 0 pass, 1 failures or stale entries, 2 incomplete.
 */
export async function run(options: RunOptions): Promise<number> {
  const missing = await missingBuilds(options.root, options.fs);
  if (missing.length > 0) {
    return incomplete(options.write, `no type declarations in ${missing.join(", ")}; run \`npm run build\` first`);
  }
  const entries = await loadSkipList(options);
  if (entries === null) return EXIT_INCOMPLETE;
  const samples = await collectSamples(options);
  if (samples.length === 0) return incomplete(options.write, "no ts or tsx code blocks under docs/, so nothing was checked");
  const outcome = compileSamples(options.ts, options.root, samples);
  if (outcome.global.length > 0) {
    return incomplete(options.write, ...outcome.global, "global compiler errors, so no sample could be checked");
  }
  return report(options.write, applySkipList(outcome.results, entries), samples.length);
}
