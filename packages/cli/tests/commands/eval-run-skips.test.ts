/**
 * Unit tests for the `--fail-on-skip` policy helpers: counting skipped
 * results, failing them on a copy of the run, the summary line and the
 * exit decision.
 */

import { describe, expect, it } from "vitest";
import type { GoldenRun, ScoreResult } from "@tuttiai/core";

import {
  applySkipPolicy,
  countSkipped,
  renderSkippedLine,
  shouldFailRun,
} from "../../src/commands/eval-run-skips.js";

const skippedSimilarity: ScoreResult = {
  scorer: "similarity",
  score: 0,
  passed: true,
  skipped: true,
  detail: "skipped: OPENAI_API_KEY not set",
};
const passedExact: ScoreResult = { scorer: "exact", score: 1, passed: true };

function mkRun(scores: Record<string, ScoreResult>): GoldenRun {
  return {
    id: "r-1",
    case_id: "case-1",
    ran_at: new Date("2026-11-10T00:00:00Z"),
    output: "hi",
    tool_sequence: [],
    tokens: 15,
    scores,
    passed: Object.values(scores).every((s) => s.passed),
  };
}

describe("countSkipped", () => {
  it("is 0 for no runs", () => {
    expect(countSkipped([])).toBe(0);
  });

  it("counts only results with skipped === true across runs", () => {
    const runs = [
      mkRun({ similarity: skippedSimilarity, exact: passedExact }),
      mkRun({ similarity: skippedSimilarity }),
      mkRun({ exact: passedExact }),
    ];
    expect(countSkipped(runs)).toBe(2);
  });

  it("ignores a result whose skipped flag is false", () => {
    expect(countSkipped([mkRun({ exact: { ...passedExact, skipped: false } })])).toBe(0);
  });
});

describe("applySkipPolicy", () => {
  it("returns the same run when the flag is off", () => {
    const run = mkRun({ similarity: skippedSimilarity });
    expect(applySkipPolicy(run, false)).toBe(run);
  });

  it("returns the same run when the flag is on and nothing was skipped", () => {
    const run = mkRun({ exact: passedExact });
    expect(applySkipPolicy(run, true)).toBe(run);
  });

  it("fails skipped results and the run on a copy, leaving the input untouched", () => {
    const run = mkRun({ similarity: skippedSimilarity, exact: passedExact });
    const out = applySkipPolicy(run, true);
    expect(out).not.toBe(run);
    expect(out.passed).toBe(false);
    expect(out.scores["similarity"]).toEqual({ ...skippedSimilarity, passed: false });
    expect(out.scores["exact"]).toBe(passedExact);
    expect(run.passed).toBe(true);
    expect(run.scores["similarity"]?.passed).toBe(true);
  });
});

describe("renderSkippedLine", () => {
  it("prints Skipped: 0 when nothing was skipped, with or without the flag", () => {
    expect(renderSkippedLine(0, false)).toBe("Skipped: 0");
    expect(renderSkippedLine(0, true)).toBe("Skipped: 0");
  });

  it("prints the count without a suffix when the flag is off", () => {
    expect(renderSkippedLine(3, false)).toBe("Skipped: 3");
  });

  it("names the flag when it fails the run", () => {
    expect(renderSkippedLine(2, true)).toBe("Skipped: 2 (failing run: --fail-on-skip)");
  });
});

describe("shouldFailRun", () => {
  it("fails a --ci run with failed cases, as before", () => {
    expect(shouldFailRun({ ci: true }, { failed: 1, skipped: 0 })).toBe(true);
  });

  it("does not fail on skips without the flag", () => {
    expect(shouldFailRun({ ci: true }, { failed: 0, skipped: 4 })).toBe(false);
    expect(shouldFailRun({}, { failed: 0, skipped: 4 })).toBe(false);
  });

  it("fails on skips with the flag, with or without --ci", () => {
    expect(shouldFailRun({ ci: true, failOnSkip: true }, { failed: 1, skipped: 1 })).toBe(true);
    expect(shouldFailRun({ failOnSkip: true }, { failed: 1, skipped: 1 })).toBe(true);
  });

  it("passes with the flag when nothing failed or skipped", () => {
    expect(shouldFailRun({ ci: true, failOnSkip: true }, { failed: 0, skipped: 0 })).toBe(false);
  });

  it("keeps a non --ci run with failures at exit 0, as before", () => {
    expect(shouldFailRun({}, { failed: 2, skipped: 0 })).toBe(false);
  });
});
