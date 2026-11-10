/**
 * JUnit output for skipped scorer results: a result `--fail-on-skip`
 * failed renders as a `ScorerSkipped` failure naming the case and the
 * scorer; with the flag off, a skipped run renders exactly as a pass.
 */

import { describe, expect, it } from "vitest";
import type { GoldenCase, GoldenRun } from "@tuttiai/core";

import { toJunitXml } from "../../src/commands/eval-run-junit.js";
import { applySkipPolicy } from "../../src/commands/eval-run-skips.js";

function mkCase(name: string): GoldenCase {
  return {
    id: "case-1",
    name,
    agent_id: "assistant",
    input: "x",
    scorers: [{ type: "similarity" }],
    created_at: new Date("2026-11-10T00:00:00Z"),
  };
}

function skippedRun(): GoldenRun {
  return {
    id: "r-1",
    case_id: "case-1",
    ran_at: new Date("2026-11-10T00:00:00Z"),
    output: "hi",
    tool_sequence: [],
    tokens: 15,
    scores: {
      similarity: {
        scorer: "similarity",
        score: 0,
        passed: true,
        skipped: true,
        detail: "skipped: OPENAI_API_KEY not set",
      },
    },
    passed: true,
  };
}

describe("toJunitXml with skipped results", () => {
  it("renders a ScorerSkipped failure naming the case and the scorer when the policy failed it", () => {
    const run = applySkipPolicy(skippedRun(), true);
    const xml = toJunitXml([{ goldenCase: mkCase("greets"), run, durationMs: 5 }]);
    expect(xml).toContain('failures="1"');
    expect(xml).toContain(
      '<failure message="case &quot;greets&quot; skipped by scorer &quot;similarity&quot;: ' +
        'skipped: OPENAI_API_KEY not set" type="ScorerSkipped">',
    );
  });

  it("renders a skipped run as a pass when the flag is off, with no <skipped> element", () => {
    const row = { goldenCase: mkCase("greets"), run: skippedRun(), durationMs: 5 };
    const passRun: GoldenRun = { ...skippedRun(), scores: {} };
    const xml = toJunitXml([row]);
    expect(xml).toBe(toJunitXml([{ ...row, run: passRun }]));
    expect(xml).toContain('failures="0"');
    expect(xml).not.toContain("<failure");
    expect(xml).not.toContain("<skipped");
  });

  it("escapes quotes and angle brackets in the case name", () => {
    const run = applySkipPolicy(skippedRun(), true);
    const xml = toJunitXml([{ goldenCase: mkCase('a "b" <c>'), run, durationMs: 5 }]);
    expect(xml).toContain("case &quot;a &quot;b&quot; &lt;c&gt;&quot; skipped by scorer");
    expect(xml).not.toContain('<c>');
  });

  it("keeps the ScorerFailed type for a real failure", () => {
    const failed: GoldenRun = {
      ...skippedRun(),
      scores: { exact: { scorer: "exact", score: 0, passed: false, detail: "outputs differ" } },
      passed: false,
    };
    const xml = toJunitXml([{ goldenCase: mkCase("greets"), run: failed, durationMs: 5 }]);
    expect(xml).toContain('<failure message="exact: outputs differ" type="ScorerFailed">');
  });
});
