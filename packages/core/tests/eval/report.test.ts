import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import { printTable } from "../../src/eval/report.js";
import type { EvalReport } from "../../src/eval/types.js";
import {
  passReport,
  failReport,
  errorReport,
  emptyReport,
  mixedReport,
  failResult,
} from "./report-fixtures.js";

// Captured by running printTable from main at 322779f, before it stopped using
// console.log, on the fixtures in report-fixtures.ts. Never regenerate these
// from the current code: they prove the output did not change.
const GOLDEN = {
  pass:
    "\n  Eval suite: Test Suite (1 cases)\n\n  \x1b[32m✔\x1b[0m t1         Passes                       1.00   1 turns  $0.003\n\n  Results: 1/1 passed (100%) | Avg: 1.00 | Total: $0.003\n\n",
  fail:
    "\n  Eval suite: Test Suite (1 cases)\n\n  \x1b[31m✗\x1b[0m t2         Fails                        0.25   3 turns  $0.012\n    \x1b[31m↳ FAIL: contains: London (actual: Paris)\x1b[0m\n    \x1b[31m↳ FAIL: answers ok (actual: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx)\x1b[0m\n\n  Results: 0/1 passed (0%) | Avg: 0.25 | Total: $0.012\n\n",
  error:
    "\n  Eval suite: Test Suite (1 cases)\n\n  \x1b[31m✗\x1b[0m a-very-lon Errors with a case name that 0.00   0 turns  $0.000\n    \x1b[31m↳ ERROR: Provider failed: eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee\x1b[0m\n\n  Results: 0/1 passed (0%) | Avg: 0.00 | Total: $0.000\n\n",
  empty:
    "\n  Eval suite: Test Suite (0 cases)\n\n\n  Results: 0/0 passed (0%) | Avg: 0.00 | Total: $0.000\n\n",
  mixed:
    "\n  Eval suite: Test Suite (3 cases)\n\n  \x1b[32m✔\x1b[0m t1         Passes                       1.00   1 turns  $0.003\n  \x1b[31m✗\x1b[0m t2         Fails                        0.25   3 turns  $0.012\n    \x1b[31m↳ FAIL: contains: London (actual: Paris)\x1b[0m\n    \x1b[31m↳ FAIL: answers ok (actual: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx)\x1b[0m\n  \x1b[31m✗\x1b[0m a-very-lon Errors with a case name that 0.00   0 turns  $0.000\n    \x1b[31m↳ ERROR: Provider failed: eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee\x1b[0m\n\n  Results: 1/3 passed (33%) | Avg: 0.42 | Total: $0.015\n\n",
} as const;

let write: MockInstance<typeof process.stdout.write>;
let log: MockInstance<typeof console.log>;

beforeEach(() => {
  write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  log = vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  const logCalls = log.mock.calls.length;
  vi.restoreAllMocks();
  expect(logCalls).toBe(0);
});

/** Print the report and return the single chunk written to stdout. */
function print(report: EvalReport): string {
  printTable(report);
  expect(write).toHaveBeenCalledTimes(1);
  return String(write.mock.calls[0]?.[0]);
}

describe("printTable", () => {
  it("prints a pass row with score, turns and cost and no detail lines", () => {
    const out = print(passReport);
    expect(out).toBe(GOLDEN.pass);
    expect(out).toContain("\x1b[32m✔\x1b[0m t1         Passes ");
    expect(out).not.toContain("↳");
  });

  it("prints a fail row with a line per failed assertion only", () => {
    const out = print(failReport);
    expect(out).toBe(GOLDEN.fail);
    expect(out).toContain("\x1b[31m✗\x1b[0m t2 ");
    expect(out).toContain("↳ FAIL: contains: London (actual: Paris)");
    expect(out).not.toContain("turns_lte");
  });

  it("uses the assertion description and cuts actual at 60 characters", () => {
    const out = print(failReport);
    expect(out).toContain("↳ FAIL: answers ok (actual: " + "x".repeat(60) + ")");
    expect(out).not.toContain("matches_regex");
    expect(out).not.toContain("x".repeat(61));
  });

  it("prints an error row with the error cut at 80 characters, counted as failed", () => {
    const out = print(errorReport);
    expect(out).toBe(GOLDEN.error);
    expect(out).toContain("↳ ERROR: Provider failed: " + "e".repeat(63) + "\x1b[0m");
    expect(out).not.toContain("e".repeat(64));
    expect(out).toContain("Results: 0/1 passed (0%)");
  });

  it("prints headers and a zero summary for an empty report, without NaN", () => {
    const out = print(emptyReport);
    expect(out).toBe(GOLDEN.empty);
    expect(out).not.toContain("NaN");
  });

  it("prints a mixed report in input order, byte for byte as before, in one write", () => {
    const out = print(mixedReport);
    expect(out).toBe(GOLDEN.mixed);
    expect(out.indexOf(" t1 ")).toBeLessThan(out.indexOf(" t2 "));
    expect(out.indexOf(" t2 ")).toBeLessThan(out.indexOf(" a-very-lon "));
  });

  it("prints only the row for a failed case with no failed assertion and no error", () => {
    const bare = { ...failResult, assertions: [] };
    const out = print({ ...failReport, results: [bare] });
    expect(out).toContain("\x1b[31m✗\x1b[0m t2 ");
    expect(out).not.toContain("↳");
  });

  it("writes format directives in a suite name verbatim", () => {
    const out = print({ ...emptyReport, suite_name: "100% %s %d %o" });
    expect(out).toContain("  Eval suite: 100% %s %d %o (0 cases)\n");
  });
});
