import { describe, expect, it } from "vitest";
import {
  formatHistoryFinding,
  historyCleanSummary,
  historyFailureSummary,
  sortHistoryFindings,
} from "../../scripts/integrity/history-report.js";
import type { HistoryFinding } from "../../scripts/integrity/history-report.js";
import { sha } from "./fake-git.js";

const A1: HistoryFinding = { rule: "a", sha: sha("2"), path: "eslint.config.js" };
const A2: HistoryFinding = { rule: "a", sha: sha("2"), path: "packages/web/vite.config.ts" };
const A3: HistoryFinding = { rule: "a", sha: sha("1"), path: "z.config.js" };
const B1: HistoryFinding = { rule: "b", sha: sha("0"), pr: 12 };
const B2: HistoryFinding = { rule: "b", sha: sha("0"), pr: 7 };

describe("sortHistoryFindings", () => {
  it("orders by rule, then SHA, then path or pull request number", () => {
    expect(sortHistoryFindings([B1, A1, B2, A3, A2])).toEqual([A3, A1, A2, B2, B1]);
  });

  it("keeps equal findings and does not change its input", () => {
    const input = [A1, A1];
    expect(sortHistoryFindings(input)).toEqual([A1, A1]);
    expect(input).toEqual([A1, A1]);
  });
});

describe("formatHistoryFinding", () => {
  it("prints rule (a) as SHA and path", () => {
    expect(formatHistoryFinding(A1)).toBe(`history (a) ${sha("2")} eslint.config.js`);
  });

  it("prints rule (b) as head SHA and pull request number", () => {
    expect(formatHistoryFinding(B2)).toBe(`history (b) ${sha("0")} PR #7`);
  });

  it("escapes ESC and CR in a path, so a file name cannot rewrite the terminal", () => {
    const line = formatHistoryFinding({ rule: "a", sha: sha("3"), path: "x\u001b[2J\r.config.js" });
    expect(line).toBe(`history (a) ${sha("3")} x\\u{1b}[2J\\u{d}.config.js`);
    expect(line.includes("\u001b") || line.includes("\r")).toBe(false);
  });
});

describe("summaries", () => {
  it("counts findings by rule", () => {
    expect(historyFailureSummary([A1, A3, B1])).toBe("check:history: 3 finding(s): 2 rule (a), 1 rule (b)");
  });

  it("says how much a clean run scanned", () => {
    expect(historyCleanSummary(42, 40)).toBe("check:history: OK, 42 merges scanned, 40 pull requests checked, no findings");
  });
});
