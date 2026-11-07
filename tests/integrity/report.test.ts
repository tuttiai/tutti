import { describe, expect, it } from "vitest";
import {
  cleanSummary,
  failureSummary,
  formatFinding,
  printablePath,
  sortFindings,
  unreadableSummary,
} from "../../scripts/integrity/report.js";
import type { Finding } from "../../scripts/integrity/types.js";

const A2: Finding = { path: "a.config.js", line: 2, rule: "NETWORK", length: 30 };
const A1: Finding = { path: "a.config.js", line: 1, rule: "DYNAMIC_CODE", length: 20 };
const AFILE: Finding = { path: "a.config.js", line: null, rule: "FILE_SIZE", length: 9302 };
const B1: Finding = { path: "packages/web/vite.config.ts", line: 1, rule: "LONG_LINE", length: 400 };

describe("report", () => {
  it("sorts by path, then line, whole-file findings first", () => {
    expect(sortFindings([B1, A2, A1, AFILE])).toEqual([AFILE, A1, A2, B1]);
  });

  it("keeps the order of findings on the same line", () => {
    const pad: Finding = { ...A1, rule: "WHITESPACE_PAD" };
    expect(sortFindings([A1, pad])).toEqual([A1, pad]);
  });

  it("does not change the array it is given", () => {
    const input = [B1, A1];
    sortFindings(input);
    expect(input).toEqual([B1, A1]);
  });

  it("formats a line finding and a whole-file finding", () => {
    expect(formatFinding(A1)).toBe("a.config.js:1 DYNAMIC_CODE len=20");
    expect(formatFinding(AFILE)).toBe("a.config.js:- FILE_SIZE len=9302");
  });

  it("summarises findings, unreadable files and a clean run", () => {
    expect(failureSummary([A1, A2, B1], 8)).toBe("check:integrity: 3 finding(s) in 2 of 8 config files");
    expect(unreadableSummary(1, 8)).toBe("check:integrity: 1 of 8 config files could not be read");
    expect(cleanSummary(8)).toBe("check:integrity: OK, 8 config files scanned, 0 findings");
  });

  it("escapes C0 and C1 control characters and DEL in a path, and leaves the rest alone", () => {
    expect(printablePath("a\u001b[2K\rb\u0000\u007f\u009b.config.js")).toBe(
      String.raw`a\u{1b}[2K\u{d}b\u{0}\u{7f}\u{9b}.config.js`,
    );
    expect(printablePath("packages/caf\u00e9/vite.config.ts")).toBe("packages/caf\u00e9/vite.config.ts");
  });

  it("prints a finding's path with its control characters escaped", () => {
    const finding: Finding = { ...A1, path: "x\u001b]0;owned\u0007.config.js" };
    expect(formatFinding(finding)).toBe(String.raw`x\u{1b}]0;owned\u{7}.config.js:1 DYNAMIC_CODE len=20`);
  });
});
