/**
 * JUnit XML builder for `tutti-ai eval run --ci`.
 *
 * GitHub Actions' built-in test reporter and every third-party test
 * reporter (mochawesome, junit-report, jest-junit) consume this
 * format. Each golden case becomes a `<testcase>`; failing cases
 * carry a `<failure>` body with the first-failing scorer's detail,
 * the unified diff, and the agent output.
 */

import type { GoldenCase, GoldenRun, ScoreResult } from "@tuttiai/core";

/** Pair of `(case, run, wall-clock duration)` — one row in the output. */
export interface JunitRow {
  goldenCase: GoldenCase;
  run: GoldenRun;
  durationMs: number;
}

function escapeXmlText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeXmlAttr(s: string): string {
  return escapeXmlText(s).replace(/"/g, "&quot;").replace(/\n/g, "&#10;");
}

function firstFailure(scores: Record<string, ScoreResult>): ScoreResult | undefined {
  return Object.values(scores).find((s) => !s.passed);
}

/**
 * Build the full JUnit XML document from a list of rows. Uses a
 * `<![CDATA[...]]>` wrapper for the failure body so newlines, `<`, and
 * `&` survive as-is; the literal `]]>` sequence is split if it ever
 * shows up in agent output.
 */
export function toJunitXml(rows: JunitRow[], suiteName = "tutti-eval"): string {
  const totalTimeSec = rows.reduce((s, r) => s + r.durationMs / 1000, 0);
  const failures = rows.filter((r) => !r.run.passed).length;
  const attrs =
    'name="' +
    escapeXmlAttr(suiteName) +
    '" tests="' +
    rows.length +
    '" failures="' +
    failures +
    '" errors="0" time="' +
    totalTimeSec.toFixed(3) +
    '"';

  const body = rows.map(renderTestCase).join("");

  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    "<testsuites " +
    attrs +
    ">\n" +
    "  <testsuite " +
    attrs +
    ">\n" +
    body +
    "  </testsuite>\n" +
    "</testsuites>\n"
  );
}

function renderTestCase({ goldenCase, run, durationMs }: JunitRow): string {
  const timeSec = (durationMs / 1000).toFixed(3);
  const caseAttrs =
    ' classname="' +
    escapeXmlAttr(goldenCase.agent_id) +
    '" name="' +
    escapeXmlAttr(goldenCase.name) +
    '" time="' +
    timeSec +
    '"';

  if (run.passed) {
    return "    <testcase" + caseAttrs + "/>\n";
  }

  const failure = firstFailure(run.scores);
  const message = failure
    ? failure.scorer + (failure.detail ? ": " + failure.detail : " failed")
    : "case failed";

  const parts: string[] = [];
  if (failure?.detail) parts.push(failure.detail);
  if (run.diff) parts.push(run.diff);
  parts.push("---- output ----\n" + run.output);
  const bodyRaw = parts.join("\n\n").replace(/]]>/g, "]]]]><![CDATA[>");

  return (
    "    <testcase" +
    caseAttrs +
    ">\n" +
    '      <failure message="' +
    escapeXmlAttr(message) +
    '" type="ScorerFailed"><![CDATA[' +
    bodyRaw +
    "]]></failure>\n" +
    "    </testcase>\n"
  );
}
