/**
 * Tests for the `tutti-ai eval list` render layer.
 *
 * Exercises the table layout, per-row status colouring (pass / FAIL /
 * never), the empty-state hint, and the `deriveLastRunStatus` helper.
 * No disk I/O — all cases and runs are fabricated here.
 */

import { describe, it, expect } from "vitest";
import chalk from "chalk";
import type { GoldenCase, GoldenRun } from "@tuttiai/core";

import {
  deriveLastRunStatus,
  renderGoldenCasesTable,
} from "../../src/commands/eval-list-render.js";

chalk.level = 1;

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*m/g, "");
}

function mkCase(overrides: Partial<GoldenCase> = {}): GoldenCase {
  return {
    id: "abcdef1234567890",
    name: "summarize Q1 report",
    agent_id: "assistant",
    input: "Summarize the Q1 report.",
    scorers: [{ type: "exact" }, { type: "tool-sequence" }],
    created_at: new Date("2026-04-15T12:00:00.000Z"),
    ...overrides,
  };
}

function mkRun(case_id: string, passed: boolean): GoldenRun {
  return {
    id: "r-" + case_id,
    case_id,
    ran_at: new Date("2026-04-15T12:05:00.000Z"),
    output: "out",
    tool_sequence: [],
    tokens: 100,
    scores: {},
    passed,
  };
}

/* ========================================================================= */
/*  deriveLastRunStatus                                                       */
/* ========================================================================= */

describe("deriveLastRunStatus", () => {
  it("returns 'never' when no run has been recorded", () => {
    expect(deriveLastRunStatus(null)).toBe("never");
    expect(deriveLastRunStatus(undefined)).toBe("never");
  });
  it("returns 'pass' for a passing run", () => {
    expect(deriveLastRunStatus(mkRun("c1", true))).toBe("pass");
  });
  it("returns 'fail' for a failing run", () => {
    expect(deriveLastRunStatus(mkRun("c1", false))).toBe("fail");
  });
});

/* ========================================================================= */
/*  renderGoldenCasesTable                                                    */
/* ========================================================================= */

describe("renderGoldenCasesTable", () => {
  it("renders the empty-state hint when no cases exist", () => {
    const out = stripAnsi(renderGoldenCasesTable([], new Map()));
    expect(out).toContain("No golden cases recorded");
    expect(out).toContain("tutti-ai eval record <session-id>");
  });

  it("prints the column header once and one row per case", () => {
    const out = stripAnsi(
      renderGoldenCasesTable(
        [mkCase({ id: "abcdef1234", name: "A" }), mkCase({ id: "fedcba4321", name: "B" })],
        new Map(),
      ),
    );
    expect(out).toContain("ID");
    expect(out).toContain("NAME");
    expect(out).toContain("AGENT");
    expect(out).toContain("SCORERS");
    expect(out).toContain("STATUS");
    expect(out).toContain("CREATED");
    // One header line + two data rows.
    expect(out.trim().split("\n")).toHaveLength(3);
  });

  it("truncates ids to 8 characters", () => {
    const out = stripAnsi(
      renderGoldenCasesTable([mkCase({ id: "abcdef1234567890" })], new Map()),
    );
    expect(out).toContain("abcdef12");
    expect(out).not.toContain("abcdef1234567890");
  });

  it("collapses scorers into a comma-separated cell", () => {
    const out = stripAnsi(
      renderGoldenCasesTable(
        [
          mkCase({
            scorers: [
              { type: "exact" },
              { type: "similarity" },
              { type: "tool-sequence" },
            ],
          }),
        ],
        new Map(),
      ),
    );
    expect(out).toContain("exact,similarity,tool-sequence");
  });

  it("renders (none) when a case has no scorers attached", () => {
    const out = stripAnsi(
      renderGoldenCasesTable([mkCase({ scorers: [] })], new Map()),
    );
    expect(out).toContain("(none)");
  });

  it("shows 'pass' / 'FAIL' / 'never' based on the latestByCaseId map", () => {
    // Names deliberately avoid the substrings "pass" / "fail" / "never"
    // so the status count isn't polluted by hits inside the NAME column.
    const cases = [
      mkCase({ id: "good-id", name: "alpha" }),
      mkCase({ id: "bad-id", name: "beta" }),
      mkCase({ id: "unrun-id", name: "gamma" }),
    ];
    const map = new Map<string, GoldenRun | null>([
      ["good-id", mkRun("good-id", true)],
      ["bad-id", mkRun("bad-id", false)],
      // unrun-id deliberately absent
    ]);
    const out = stripAnsi(renderGoldenCasesTable(cases, map));
    expect(out.match(/\bpass\b/g)?.length).toBe(1);
    expect(out.match(/\bFAIL\b/g)?.length).toBe(1);
    expect(out.match(/\bnever\b/g)?.length).toBe(1);
  });

  it("colours pass green, FAIL red, never dim", () => {
    const cases = [
      mkCase({ id: "good-id", name: "a" }),
      mkCase({ id: "bad-id", name: "b" }),
      mkCase({ id: "unrun-id", name: "c" }),
    ];
    const map = new Map<string, GoldenRun | null>([
      ["good-id", mkRun("good-id", true)],
      ["bad-id", mkRun("bad-id", false)],
    ]);
    const raw = renderGoldenCasesTable(cases, map);
    expect(raw).toContain("\u001b[32mpass\u001b[39m"); // green
    expect(raw).toContain("\u001b[31mFAIL\u001b[39m"); // red
    expect(raw).toContain("\u001b[2mnever\u001b[22m"); // dim
  });

  it("formats the created timestamp as YYYY-MM-DD HH:MM", () => {
    const out = stripAnsi(
      renderGoldenCasesTable(
        [mkCase({ created_at: new Date("2026-04-15T12:30:00.000Z") })],
        new Map(),
      ),
    );
    expect(out).toContain("2026-04-15 12:30");
  });

  it("truncates over-long names with an ellipsis", () => {
    const longName = "x".repeat(100);
    const out = stripAnsi(
      renderGoldenCasesTable([mkCase({ name: longName })], new Map()),
    );
    expect(out).not.toContain(longName);
    expect(out).toContain("\u2026");
  });
});
