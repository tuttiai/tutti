import { describe, expect, it } from "vitest";
import { applySkipList, parseSkipList } from "../../docs/scripts/samples/skip-list.js";
import type { SkipEntry } from "../../docs/scripts/samples/skip-list.js";
import type { Sample, SampleResult } from "../../docs/scripts/samples/types.js";

const FILE = "docs/src/content/docs/guides/x.mdx";
const ENTRY = { file: FILE, heading: "setup", index: 1, reason: "partial snippet" };

function list(...samples: unknown[]): string {
  return JSON.stringify({ samples });
}

function errorsOf(text: string): readonly string[] {
  const parsed = parseSkipList(text);
  return parsed.ok ? [] : parsed.errors;
}

function result(heading: string, index: number, failing: boolean): SampleResult {
  const sample: Sample = { file: FILE, heading, index, lang: "ts", startLine: 1, indent: 0, code: "" };
  return { sample, diagnostics: failing ? [{ line: 1, column: 1, code: 2304, message: "Cannot find name 'x'." }] : [] };
}

describe("parseSkipList", () => {
  it("accepts a valid list, including an empty heading, and an empty one", () => {
    const other = { ...ENTRY, heading: "", index: 2 };
    expect(parseSkipList(list(ENTRY, other))).toEqual({ ok: true, entries: [ENTRY, other] });
    expect(parseSkipList(list())).toEqual({ ok: true, entries: [] });
  });

  it("fails cleanly, without throwing, on JSON that does not parse or has no samples array", () => {
    for (const text of ["{ not json", "", "[]", "null", '{"samples":{}}']) {
      expect(errorsOf(text)).toEqual(['must be JSON of the form { "samples": [ ... ] }']);
    }
  });

  it("names each malformed entry by position and field", () => {
    const errors = errorsOf(list("x", { ...ENTRY, file: 3 }, { ...ENTRY, heading: null }, { ...ENTRY, index: 0 }, { ...ENTRY, index: 1.5 }));
    expect(errors).toEqual([
      "samples[0]: must be an object with file, heading, index and reason",
      expect.stringMatching(/^samples\[1\]\.file: /),
      'samples[2].heading: must be a string ("" for no heading)',
      "samples[3].index: must be a whole number of 1 or more",
      "samples[4].index: must be a whole number of 1 or more",
    ]);
  });

  it("rejects a missing or blank reason", () => {
    const noReason = { file: FILE, heading: "setup", index: 1 };
    expect(errorsOf(list(noReason, { ...ENTRY, index: 2, reason: "   " }))).toEqual([
      "samples[0].reason: must be a non-empty string",
      "samples[1].reason: must be a non-empty string",
    ]);
  });

  it("rejects a second entry for the same sample", () => {
    expect(errorsOf(list(ENTRY, { ...ENTRY, reason: "again" }))).toEqual([`samples[1]: a second entry for ${FILE}#setup#1`]);
  });

  it("rejects a file outside docs/, climbing out, or not an .mdx file", () => {
    const files = ["../etc/passwd.mdx", "docs/../../x.mdx", "/docs/x.mdx", "docs/./x.mdx", "docs//x.mdx", "docs\\x.mdx", "docs/x.md", "src/x.mdx"];
    const errors = errorsOf(list(...files.map((file) => ({ ...ENTRY, file }))));
    expect(errors).toHaveLength(files.length);
    for (const error of errors) expect(error).toMatch(/\.file: must be a docs\/\*\*\/\*\.mdx path/);
  });
});

describe("applySkipList", () => {
  const entries: SkipEntry[] = [ENTRY, { ...ENTRY, heading: "usage", index: 1 }, { ...ENTRY, heading: "gone", index: 4 }];

  it("skips listed failures, fails unlisted ones, and reports entries that now pass or match nothing", () => {
    const results = [result("setup", 1, true), result("setup", 2, true), result("usage", 1, false), result("usage", 2, false)];
    const verdict = applySkipList(results, entries);
    expect(verdict.passed).toBe(2);
    expect(verdict.skipped.map((r) => r.sample.index)).toEqual([1]);
    expect(verdict.failures.map((r) => `${r.sample.heading}#${r.sample.index}`)).toEqual(["setup#2"]);
    expect(verdict.nowPasses).toEqual([entries[1]]);
    expect(verdict.stale).toEqual([entries[2]]);
  });

  it("passes everything when there is no list and every sample type-checks", () => {
    expect(applySkipList([result("a", 1, false)], [])).toEqual({ passed: 1, failures: [], skipped: [], nowPasses: [], stale: [] });
  });
});
