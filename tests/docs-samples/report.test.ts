import { describe, expect, it } from "vitest";
import { EXIT_FAIL, EXIT_PASS, describeKey, formatDiagnostic, report } from "../../docs/scripts/samples/report.js";
import type { Verdict } from "../../docs/scripts/samples/skip-list.js";
import type { Sample } from "../../docs/scripts/samples/types.js";
import { captureWriter } from "./fake-fs.js";

const FILE = "docs/src/content/docs/guides/x.mdx";
const SAMPLE: Sample = { file: FILE, heading: "setup", index: 2, lang: "ts", startLine: 5, indent: 0, code: "" };
const DIAGNOSTIC = { line: 7, column: 3, code: 2304, message: "Cannot find name 'score'." };
const EMPTY: Verdict = { passed: 3, failures: [], skipped: [], nowPasses: [], stale: [] };

describe("formatDiagnostic and describeKey", () => {
  it("print file:line:col TS<code> message, and the key as it goes in the skip list", () => {
    expect(formatDiagnostic(FILE, DIAGNOSTIC)).toBe(`${FILE}:7:3 TS2304 Cannot find name 'score'.`);
    expect(describeKey(SAMPLE)).toBe(`${FILE} (heading "setup", index 2)`);
  });
});

describe("report", () => {
  it("exits 0 with the summary on stdout when nothing fails", () => {
    const { write, out, err } = captureWriter();
    const verdict = { ...EMPTY, skipped: [{ sample: SAMPLE, diagnostics: [DIAGNOSTIC] }] };
    expect(report(write, verdict, 4)).toBe(EXIT_PASS);
    expect(out).toEqual(["docs:check-samples: 4 checked, 3 passed, 1 skipped, 0 failed, 0 stale"]);
    expect(err).toEqual([]);
  });

  it("exits 1 and lists each failure, each entry that now passes or is stale, then the summary", () => {
    const { write, out, err } = captureWriter();
    const entry = { file: FILE, heading: "usage", index: 1, reason: "partial snippet" };
    const verdict: Verdict = {
      ...EMPTY,
      failures: [{ sample: SAMPLE, diagnostics: [DIAGNOSTIC] }],
      nowPasses: [entry],
      stale: [{ ...entry, index: 9 }],
    };
    expect(report(write, verdict, 5)).toBe(EXIT_FAIL);
    expect(out).toEqual([]);
    expect(err).toEqual([
      `${FILE}:7:3 TS2304 Cannot find name 'score'.`,
      `${FILE} (heading "setup", index 2): fails and is not in the skip list`,
      `${FILE} (heading "usage", index 1): now passes, remove from skip list`,
      `${FILE} (heading "usage", index 9): stale entry, no such block`,
      "docs:check-samples: 5 checked, 3 passed, 0 skipped, 1 failed, 2 stale",
    ]);
  });
});
