/**
 * Tests for the pure `eval run` render + filter helpers.
 *
 * Covers everything reachable without the store or the runner: case
 * filtering, per-case line rendering (colored interactive + plain CI),
 * diff truncation, and the summary footer.
 */

import { describe, expect, it } from "vitest";
import chalk from "chalk";
import type { GoldenCase, GoldenRun } from "@tuttiai/core";

import {
  DIFF_PREVIEW_LINES,
  computeStats,
  filterCases,
  firstFailure,
  renderCaseLine,
  renderCaseLineCI,
  renderSummary,
  truncateDiffPreview,
} from "../../src/commands/eval-run-render.js";

chalk.level = 1;

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*m/g, "");
}

function mkCase(overrides: Partial<GoldenCase> = {}): GoldenCase {
  return {
    id: "abcdef1234567890",
    name: "summarize Q1",
    agent_id: "assistant",
    input: "x",
    scorers: [{ type: "exact" }],
    created_at: new Date("2026-04-15T12:00:00Z"),
    ...overrides,
  };
}

function mkRun(passed: boolean, overrides: Partial<GoldenRun> = {}): GoldenRun {
  // Helper keeps `cost_usd` omitted by default so tests can isolate the
  // "undefined cost doesn't add to totalCostUsd" behaviour. Tests that
  // want a cost set one explicitly in `overrides`.
  return {
    id: "r-1",
    case_id: "abcdef1234567890",
    ran_at: new Date("2026-04-15T12:00:00Z"),
    output: "out",
    tool_sequence: [],
    tokens: 420,
    scores: {
      exact: {
        scorer: "exact",
        score: passed ? 1 : 0,
        passed,
        ...(passed ? {} : { detail: "mismatch" }),
      },
    },
    passed,
    ...overrides,
  };
}

/* ========================================================================= */
/*  filterCases                                                               */
/* ========================================================================= */

describe("filterCases", () => {
  const cases = [
    mkCase({ id: "aaaa1111", name: "alpha", tags: ["smoke"] }),
    mkCase({ id: "bbbb2222", name: "beta", tags: ["regression"] }),
    mkCase({ id: "aaaa3333", name: "alpha-dup", tags: ["smoke", "regression"] }),
  ];

  it("returns every case when no filters are provided", () => {
    expect(filterCases(cases, {})).toHaveLength(3);
  });

  it("matches the full id exactly", () => {
    expect(filterCases(cases, { case: "bbbb2222" }).map((c) => c.name)).toEqual(["beta"]);
  });

  it("matches an id prefix (eg the 8-char display form)", () => {
    // "aaaa" prefixes both aaaa1111 and aaaa3333.
    expect(filterCases(cases, { case: "aaaa" }).map((c) => c.name)).toEqual([
      "alpha",
      "alpha-dup",
    ]);
  });

  it("filters by tag", () => {
    expect(filterCases(cases, { tag: "smoke" }).map((c) => c.name)).toEqual([
      "alpha",
      "alpha-dup",
    ]);
  });

  it("ANDs case + tag when both are provided", () => {
    const out = filterCases(cases, { case: "aaaa", tag: "regression" });
    expect(out).toHaveLength(1);
    expect(out[0]!.name).toBe("alpha-dup");
  });

  it("treats missing tags[] as an empty list", () => {
    const noTags = mkCase({ id: "cccc1234", name: "no-tags" });
    expect(filterCases([noTags], { tag: "smoke" })).toEqual([]);
  });
});

/* ========================================================================= */
/*  truncateDiffPreview                                                       */
/* ========================================================================= */

describe("truncateDiffPreview", () => {
  it("leaves short diffs untouched", () => {
    const diff = "--- a\n+++ b\n-foo\n+bar";
    expect(truncateDiffPreview(diff)).toBe(diff);
  });

  it("clips to the default line limit with an ellipsis notice", () => {
    const lines = Array.from({ length: DIFF_PREVIEW_LINES + 5 }, (_, i) => "line" + i);
    const out = truncateDiffPreview(lines.join("\n"));
    const outLines = out.split("\n");
    expect(outLines).toHaveLength(DIFF_PREVIEW_LINES + 1); // +1 for notice
    expect(outLines.at(-1)).toMatch(/5 more lines/);
  });

  it("honours a custom maxLines argument", () => {
    const diff = Array.from({ length: 10 }, (_, i) => "l" + i).join("\n");
    const out = truncateDiffPreview(diff, 3);
    expect(out.split("\n").slice(0, 3)).toEqual(["l0", "l1", "l2"]);
    expect(out).toMatch(/7 more lines/);
  });
});

/* ========================================================================= */
/*  firstFailure                                                              */
/* ========================================================================= */

describe("firstFailure", () => {
  it("returns the first scorer where passed is false", () => {
    const f = firstFailure({
      a: { scorer: "a", score: 1, passed: true },
      b: { scorer: "b", score: 0, passed: false, detail: "nope" },
      c: { scorer: "c", score: 0, passed: false },
    });
    expect(f?.scorer).toBe("b");
  });
  it("returns undefined when every scorer passed", () => {
    expect(firstFailure({ a: { scorer: "a", score: 1, passed: true } })).toBeUndefined();
  });
});

/* ========================================================================= */
/*  renderCaseLine (interactive)                                              */
/* ========================================================================= */

describe("renderCaseLine", () => {
  it("prints a green ✓ with score summary on pass", () => {
    const raw = renderCaseLine(mkCase({ name: "alpha" }), mkRun(true));
    expect(raw).toContain("\u001b[32m\u2713 \u001b[39m");
    const plain = stripAnsi(raw);
    expect(plain).toContain("\u2713 alpha");
    expect(plain).toContain("exact:1.00");
  });

  it("prints a red ✗ with failing-scorer detail on fail", () => {
    const raw = renderCaseLine(mkCase({ name: "beta" }), mkRun(false));
    expect(raw).toContain("\u001b[31m\u2717 \u001b[39m");
    const plain = stripAnsi(raw);
    expect(plain).toContain("\u2717 beta");
    expect(plain).toContain("exact: mismatch");
  });

  it("appends a truncated diff preview when the run carries one", () => {
    const longDiff = Array.from({ length: 30 }, (_, i) => "d" + i).join("\n");
    const raw = renderCaseLine(
      mkCase({ name: "gamma" }),
      mkRun(false, { diff: longDiff }),
    );
    const plain = stripAnsi(raw);
    expect(plain).toContain("d0");
    expect(plain).toMatch(/10 more lines/);
  });
});

/* ========================================================================= */
/*  renderCaseLineCI (plain)                                                  */
/* ========================================================================= */

describe("renderCaseLineCI", () => {
  it("uses PASS + 8-char id + tokens + cost on success", () => {
    const out = renderCaseLineCI(
      mkCase({ name: "alpha" }),
      mkRun(true, { cost_usd: 0.01 }),
    );
    expect(out).toMatch(/^PASS abcdef12 alpha/);
    expect(out).toContain("tokens=420");
    expect(out).toContain("cost=$0.0100");
    expect(out).toContain("[exact:1.00]");
  });

  it("uses FAIL + why suffix on failure", () => {
    const out = renderCaseLineCI(mkCase({ name: "beta" }), mkRun(false));
    expect(out).toMatch(/^FAIL abcdef12 beta/);
    expect(out).toContain("why=exact");
  });

  it("emits no ANSI escape sequences", () => {
    // eslint-disable-next-line no-control-regex
    const ansi = /\u001b\[/;
    expect(ansi.test(renderCaseLineCI(mkCase(), mkRun(true)))).toBe(false);
    expect(ansi.test(renderCaseLineCI(mkCase(), mkRun(false)))).toBe(false);
  });

  it("omits cost= when cost_usd is absent", () => {
    // mkRun's default already omits cost_usd.
    const out = renderCaseLineCI(mkCase(), mkRun(true, { tokens: 5 }));
    expect(out).not.toContain("cost=");
    expect(out).toContain("tokens=5");
  });
});

/* ========================================================================= */
/*  computeStats + renderSummary                                              */
/* ========================================================================= */

describe("computeStats", () => {
  it("counts pass/fail and sums tokens + cost", () => {
    const stats = computeStats([
      mkRun(true, { tokens: 100, cost_usd: 0.001 }),
      mkRun(false, { tokens: 200, cost_usd: 0.002 }),
      mkRun(true, { tokens: 300 }), // no cost_usd
    ]);
    expect(stats.passed).toBe(2);
    expect(stats.failed).toBe(1);
    expect(stats.total).toBe(3);
    expect(stats.totalTokens).toBe(600);
    // Cost uses floating-point summation; assert with a tolerance.
    expect(stats.totalCostUsd).toBeCloseTo(0.003, 10);
  });

  it("handles the empty list gracefully", () => {
    expect(computeStats([])).toEqual({
      passed: 0,
      failed: 0,
      total: 0,
      totalTokens: 0,
      totalCostUsd: 0,
    });
  });
});

describe("renderSummary", () => {
  const stats = {
    passed: 7,
    failed: 3,
    total: 10,
    totalTokens: 5000,
    totalCostUsd: 1.234,
  };

  it("prints counts, avg tokens, and total cost", () => {
    const plain = stripAnsi(renderSummary(stats, true));
    expect(plain).toContain("7 passed");
    expect(plain).toContain("3 failed");
    expect(plain).toContain("out of 10 cases");
    expect(plain).toContain("avg tokens: 500");
    expect(plain).toContain("total cost: $1.23");
  });

  it("colors passed / failed when colors=true", () => {
    const raw = renderSummary(stats, true);
    expect(raw).toContain("\u001b[32m7 passed\u001b[39m");
    expect(raw).toContain("\u001b[31m3 failed\u001b[39m");
  });

  it("omits ANSI entirely when colors=false", () => {
    const raw = renderSummary(stats, false);
    // eslint-disable-next-line no-control-regex
    expect(/\u001b\[/.test(raw)).toBe(false);
  });

  it("renders avg tokens as 0 when no cases were run", () => {
    const plain = stripAnsi(
      renderSummary(
        { passed: 0, failed: 0, total: 0, totalTokens: 0, totalCostUsd: 0 },
        false,
      ),
    );
    expect(plain).toContain("avg tokens: 0");
  });
});
