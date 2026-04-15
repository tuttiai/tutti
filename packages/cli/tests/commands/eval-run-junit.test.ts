/**
 * Tests for the JUnit XML builder used by `tutti-ai eval run --ci`.
 *
 * Asserts the output is valid JUnit XML, carries the right counts,
 * escapes attributes + CDATA sequences, and includes the diff / scorer
 * detail / output in failure bodies.
 */

import { describe, expect, it } from "vitest";
import type { GoldenCase, GoldenRun } from "@tuttiai/core";

import { toJunitXml } from "../../src/commands/eval-run-junit.js";

function mkCase(overrides: Partial<GoldenCase> = {}): GoldenCase {
  return {
    id: "case-1",
    name: "summarize Q1",
    agent_id: "assistant",
    input: "x",
    scorers: [{ type: "exact" }],
    created_at: new Date(),
    ...overrides,
  };
}

function mkRun(passed: boolean, overrides: Partial<GoldenRun> = {}): GoldenRun {
  return {
    id: "r-1",
    case_id: "case-1",
    ran_at: new Date(),
    output: "hello",
    tool_sequence: [],
    tokens: 10,
    scores: {
      exact: {
        scorer: "exact",
        score: passed ? 1 : 0,
        passed,
        ...(passed ? {} : { detail: "outputs differ" }),
      },
    },
    passed,
    ...overrides,
  };
}

describe("toJunitXml — document structure", () => {
  it("starts with an XML declaration and a <testsuites> root", () => {
    const xml = toJunitXml([
      { goldenCase: mkCase(), run: mkRun(true), durationMs: 100 },
    ]);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain("<testsuites ");
    expect(xml).toContain("</testsuites>");
    expect(xml).toContain("<testsuite ");
    expect(xml).toContain("</testsuite>");
  });

  it("carries correct tests / failures / time counts on <testsuites>", () => {
    const xml = toJunitXml([
      { goldenCase: mkCase({ id: "a" }), run: mkRun(true), durationMs: 500 },
      { goldenCase: mkCase({ id: "b" }), run: mkRun(false), durationMs: 250 },
      { goldenCase: mkCase({ id: "c" }), run: mkRun(false), durationMs: 125 },
    ]);
    expect(xml).toMatch(/<testsuites[^>]*tests="3"/);
    expect(xml).toMatch(/<testsuites[^>]*failures="2"/);
    expect(xml).toMatch(/<testsuites[^>]*errors="0"/);
    // 500 + 250 + 125 = 875 ms → 0.875 seconds.
    expect(xml).toMatch(/<testsuites[^>]*time="0\.875"/);
  });

  it("uses a self-closing <testcase/> tag for passing cases", () => {
    const xml = toJunitXml([
      { goldenCase: mkCase({ name: "ok" }), run: mkRun(true), durationMs: 10 },
    ]);
    expect(xml).toMatch(/<testcase[^>]*name="ok"[^>]*\/>/);
    expect(xml).not.toContain("<failure");
  });

  it("includes a <failure> with scorer message + CDATA body for failing cases", () => {
    const xml = toJunitXml([
      {
        goldenCase: mkCase({ name: "broken" }),
        run: mkRun(false, {
          diff: "--- expected\n+++ actual\n-a\n+b",
          output: "actual output",
        }),
        durationMs: 10,
      },
    ]);
    expect(xml).toMatch(/<failure[^>]*message="exact: outputs differ"/);
    expect(xml).toContain("type=\"ScorerFailed\"");
    expect(xml).toContain("<![CDATA[");
    expect(xml).toContain("]]>");
    expect(xml).toContain("--- expected");
    expect(xml).toContain("---- output ----");
    expect(xml).toContain("actual output");
  });

  it("sets classname to the agent_id and name to the case name", () => {
    const xml = toJunitXml([
      {
        goldenCase: mkCase({ name: "alpha", agent_id: "reviewer" }),
        run: mkRun(true),
        durationMs: 10,
      },
    ]);
    expect(xml).toMatch(/classname="reviewer"/);
    expect(xml).toMatch(/name="alpha"/);
  });
});

describe("toJunitXml — escaping", () => {
  it("escapes quotes / &lt; / &amp; in attributes", () => {
    const xml = toJunitXml([
      {
        goldenCase: mkCase({ name: 'al"pha & <beta>' }),
        run: mkRun(true),
        durationMs: 10,
      },
    ]);
    expect(xml).toContain('name="al&quot;pha &amp; &lt;beta&gt;"');
  });

  it("escapes newlines in attribute values", () => {
    const xml = toJunitXml([
      {
        goldenCase: mkCase({ name: "line1\nline2" }),
        run: mkRun(false, { diff: "d" }),
        durationMs: 10,
      },
    ]);
    // Newlines in the `name` attribute are replaced by the XML entity.
    expect(xml).toContain('name="line1&#10;line2"');
  });

  it("splits the literal ']]>' sequence inside CDATA bodies", () => {
    const sneakyOutput = "before ]]> after";
    const xml = toJunitXml([
      {
        goldenCase: mkCase(),
        run: mkRun(false, { output: sneakyOutput }),
        durationMs: 10,
      },
    ]);
    // The raw ']]>' does not appear INSIDE the CDATA block — the escaping
    // closes the CDATA, writes `]]>`, and reopens a new one.
    expect(xml).toContain("]]]]><![CDATA[>");
    // And there's exactly one document-level CDATA close (the one at the
    // end of the failure body).
    const cdataCloses = xml.match(/]]>/g) ?? [];
    expect(cdataCloses.length).toBeGreaterThanOrEqual(2);
  });
});

describe("toJunitXml — empty input", () => {
  it("emits a valid empty suite when no rows are passed", () => {
    const xml = toJunitXml([]);
    expect(xml).toMatch(/tests="0"/);
    expect(xml).toMatch(/failures="0"/);
    expect(xml).toMatch(/time="0\.000"/);
    expect(xml).not.toContain("<testcase");
  });
});
