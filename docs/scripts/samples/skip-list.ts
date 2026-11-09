import { keyOf } from "./types.js";
import type { SampleKey, SampleResult } from "./types.js";

/** One checked-in skip-list entry: a sample that fails today, and why. */
export interface SkipEntry extends SampleKey {
  /** Why it fails: "partial snippet", "pseudo-code", "uses removed API X" or the first TS code. */
  readonly reason: string;
}

/** The result of reading the skip list: its entries, or every problem found in it. */
export type SkipListParse =
  | { readonly ok: true; readonly entries: readonly SkipEntry[] }
  | { readonly ok: false; readonly errors: readonly string[] };

/** How the samples' results compare with the skip list. */
export interface Verdict {
  /** Samples with no diagnostics, listed or not. */
  readonly passed: number;
  /** Samples with diagnostics and no skip-list entry: these fail the run. */
  readonly failures: readonly SampleResult[];
  /** Samples with diagnostics and a skip-list entry. */
  readonly skipped: readonly SampleResult[];
  /** Entries whose sample now type-checks: these fail the run until removed. */
  readonly nowPasses: readonly SkipEntry[];
  /** Entries that match no sample: these fail the run until fixed or removed. */
  readonly stale: readonly SkipEntry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A repository-relative .mdx path under docs/ that cannot climb out or be read two ways. */
function isDocsPath(file: string): boolean {
  if (!file.startsWith("docs/") || !file.endsWith(".mdx") || file.includes("\\")) return false;
  return !file.split("/").some((part) => part === "" || part === "." || part === "..");
}

function toEntry(value: unknown, at: string): SkipEntry | string {
  if (!isRecord(value)) return `${at}: must be an object with file, heading, index and reason`;
  const { file, heading, index, reason } = value;
  if (typeof file !== "string" || !isDocsPath(file)) {
    return `${at}.file: must be a docs/**/*.mdx path relative to the repository root, without "..", "." or "\\"`;
  }
  if (typeof heading !== "string") return `${at}.heading: must be a string ("" for no heading)`;
  if (typeof index !== "number" || !Number.isInteger(index) || index < 1) {
    return `${at}.index: must be a whole number of 1 or more`;
  }
  if (typeof reason !== "string" || reason.trim() === "") return `${at}.reason: must be a non-empty string`;
  return { file, heading, index, reason };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Reads and validates the skip list, `{ "samples": [ { file, heading, index, reason } ] }`.
 * Every problem is reported, not just the first: invalid JSON, a missing `samples` array, an
 * entry of the wrong shape, a path outside docs/ or not an .mdx file, an index below 1, an empty
 * reason, or a second entry for the same sample. It never throws.
 *
 * @param text - The file's content.
 * @returns The entries, or the problems found, each prefixed with where it is.
 */
export function parseSkipList(text: string): SkipListParse {
  const data = parseJson(text);
  if (!isRecord(data) || !Array.isArray(data.samples)) {
    return { ok: false, errors: ['must be JSON of the form { "samples": [ ... ] }'] };
  }
  const errors: string[] = [];
  const entries: SkipEntry[] = [];
  const seen = new Set<string>();
  data.samples.forEach((value: unknown, i: number) => {
    const entry = toEntry(value, `samples[${i}]`);
    if (typeof entry === "string") errors.push(entry);
    else if (seen.has(keyOf(entry))) errors.push(`samples[${i}]: a second entry for ${keyOf(entry)}`);
    else {
      seen.add(keyOf(entry));
      entries.push(entry);
    }
  });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, entries };
}

/**
 * Sorts each sample's result against the skip list. The list may only shrink: an entry whose
 * sample now passes, and an entry that names no sample, are reported so the run can fail on them.
 *
 * @param results - Every sample's result.
 * @param entries - The validated skip-list entries.
 * @returns The verdict.
 */
export function applySkipList(results: readonly SampleResult[], entries: readonly SkipEntry[]): Verdict {
  const byKey = new Map(entries.map((entry) => [keyOf(entry), entry]));
  const matched = new Set<string>();
  const failures: SampleResult[] = [];
  const skipped: SampleResult[] = [];
  const nowPasses: SkipEntry[] = [];
  let passed = 0;
  for (const result of results) {
    const key = keyOf(result.sample);
    const entry = byKey.get(key);
    if (entry !== undefined) matched.add(key);
    if (result.diagnostics.length === 0) {
      passed += 1;
      if (entry !== undefined) nowPasses.push(entry);
    } else if (entry !== undefined) skipped.push(result);
    else failures.push(result);
  }
  const stale = entries.filter((entry) => !matched.has(keyOf(entry)));
  return { passed, failures, skipped, nowPasses, stale };
}
