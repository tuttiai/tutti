/**
 * Tests for the pure `eval record` render + extraction helpers.
 *
 * Covers everything reachable without the enquirer driver or disk I/O:
 * session → draft extraction, the 200-char summary truncation, default
 * case-name derivation, tag / tool parsing, and the draft+answers →
 * GoldenCase composer.
 */

import { describe, it, expect } from "vitest";
import chalk from "chalk";
import type { Session } from "@tuttiai/core";

import {
  buildGoldenCase,
  deriveDefaultCaseName,
  extractSessionDraft,
  parseTagInput,
  parseToolSequenceInput,
  renderRecordedConfirmation,
  renderSessionSummary,
  truncate200,
  type RecordAnswers,
} from "../../src/commands/eval-record-render.js";

// Pin chalk so the ANSI assertions fire even off a TTY.
chalk.level = 1;

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*m/g, "");
}

function mkSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "sess-abc",
    agent_name: "assistant",
    messages: [
      { role: "user", content: "Summarize the Q1 report." },
      { role: "assistant", content: "Q1 revenue rose 12%." },
    ],
    created_at: new Date("2026-04-15T12:00:00.000Z"),
    updated_at: new Date("2026-04-15T12:00:30.000Z"),
    ...overrides,
  };
}

/* ========================================================================= */
/*  extractSessionDraft                                                       */
/* ========================================================================= */

describe("extractSessionDraft", () => {
  it("pulls the first user message as input and the last assistant message as output", () => {
    const draft = extractSessionDraft(mkSession());
    expect(draft.input).toBe("Summarize the Q1 report.");
    expect(draft.output).toBe("Q1 revenue rose 12%.");
    expect(draft.tool_sequence).toEqual([]);
  });

  it("concatenates text blocks when the message content is a block array", () => {
    const draft = extractSessionDraft(
      mkSession({
        messages: [
          { role: "user", content: "question?" },
          {
            role: "assistant",
            content: [
              { type: "text", text: "part one " },
              { type: "text", text: "part two" },
            ],
          },
        ],
      }),
    );
    expect(draft.output).toBe("part one part two");
  });

  it("collects tool_use names in order across every assistant message", () => {
    const draft = extractSessionDraft(
      mkSession({
        messages: [
          { role: "user", content: "hi" },
          {
            role: "assistant",
            content: [
              { type: "tool_use", id: "t1", name: "search_knowledge", input: {} },
            ],
          },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
          {
            role: "assistant",
            content: [
              { type: "tool_use", id: "t2", name: "web_search", input: {} },
              { type: "text", text: "thinking" },
            ],
          },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: "ok" }] },
          { role: "assistant", content: "final answer" },
        ],
      }),
    );
    expect(draft.tool_sequence).toEqual(["search_knowledge", "web_search"]);
    expect(draft.output).toBe("final answer");
  });

  it("returns empty strings and an empty sequence when the session has no messages", () => {
    const draft = extractSessionDraft(mkSession({ messages: [] }));
    expect(draft).toEqual({ input: "", output: "", tool_sequence: [] });
  });

  it("ignores tool_use / tool_result blocks when resolving input and output text", () => {
    const draft = extractSessionDraft(
      mkSession({
        messages: [
          { role: "user", content: [{ type: "text", text: "real input" }] },
          {
            role: "assistant",
            content: [
              { type: "tool_use", id: "t", name: "noop", input: {} },
              { type: "text", text: "real output" },
            ],
          },
        ],
      }),
    );
    expect(draft.input).toBe("real input");
    expect(draft.output).toBe("real output");
  });
});

/* ========================================================================= */
/*  truncate200 + renderSessionSummary                                        */
/* ========================================================================= */

describe("truncate200", () => {
  it("leaves short strings alone", () => {
    expect(truncate200("hi")).toBe("hi");
  });
  it("compacts repeated whitespace", () => {
    expect(truncate200("a   b\n\nc")).toBe("a b c");
  });
  it("appends an ellipsis past 200 chars", () => {
    const long = "x".repeat(500);
    const out = truncate200(long);
    expect(out.length).toBe(200);
    expect(out.endsWith("\u2026")).toBe(true);
  });
});

describe("renderSessionSummary", () => {
  it("includes session id, agent, tokens, and truncated input/output", () => {
    const session = mkSession();
    const draft = extractSessionDraft(session);
    const out = stripAnsi(renderSessionSummary(session, draft, 420));
    expect(out).toContain("Session summary");
    expect(out).toContain("sess-abc");
    expect(out).toContain("assistant");
    expect(out).toContain("Tokens:  420");
    expect(out).toContain("Summarize the Q1 report.");
    expect(out).toContain("Q1 revenue rose 12%.");
  });

  it("renders an em-dash for unknown token count", () => {
    const session = mkSession();
    const draft = extractSessionDraft(session);
    const out = stripAnsi(renderSessionSummary(session, draft, undefined));
    expect(out).toContain("Tokens:  \u2014");
  });

  it("renders (none) when no tool calls were made", () => {
    const session = mkSession();
    const draft = extractSessionDraft(session);
    const out = stripAnsi(renderSessionSummary(session, draft, 100));
    expect(out).toContain("Tools:");
    expect(out).toContain("(none)");
  });

  it("joins the tool sequence with an arrow when present", () => {
    const session = mkSession();
    const draft = { input: "i", output: "o", tool_sequence: ["search", "fetch"] };
    const out = stripAnsi(renderSessionSummary(session, draft, 50));
    expect(out).toContain("search");
    expect(out).toContain("fetch");
    expect(out).toContain("\u2192");
  });
});

/* ========================================================================= */
/*  Prompt helpers                                                            */
/* ========================================================================= */

describe("deriveDefaultCaseName", () => {
  it("returns the input verbatim when short", () => {
    expect(deriveDefaultCaseName("summarize Q1")).toBe("summarize Q1");
  });
  it("truncates to 40 chars", () => {
    const long = "x".repeat(100);
    expect(deriveDefaultCaseName(long)).toHaveLength(40);
  });
  it("compacts whitespace", () => {
    expect(deriveDefaultCaseName("  hello\n\tworld  ")).toBe("hello world");
  });
});

describe("parseTagInput", () => {
  it("splits on commas and trims", () => {
    expect(parseTagInput("a, b ,c")).toEqual(["a", "b", "c"]);
  });
  it("drops empty entries", () => {
    expect(parseTagInput(", a, ,")).toEqual(["a"]);
  });
  it("returns [] for empty input", () => {
    expect(parseTagInput("")).toEqual([]);
    expect(parseTagInput("   ")).toEqual([]);
  });
});

describe("parseToolSequenceInput", () => {
  it("splits on commas", () => {
    expect(parseToolSequenceInput("a, b, c")).toEqual(["a", "b", "c"]);
  });
  it("splits on arrows (both -> and →)", () => {
    expect(parseToolSequenceInput("a -> b \u2192 c")).toEqual(["a", "b", "c"]);
  });
  it("accepts a mix of separators", () => {
    expect(parseToolSequenceInput("a, b -> c")).toEqual(["a", "b", "c"]);
  });
  it("returns [] for empty input", () => {
    expect(parseToolSequenceInput("")).toEqual([]);
  });
});

/* ========================================================================= */
/*  buildGoldenCase                                                           */
/* ========================================================================= */

describe("buildGoldenCase", () => {
  const NOW = new Date("2026-04-15T12:34:56.000Z");

  function answers(overrides: Partial<RecordAnswers> = {}): RecordAnswers {
    return {
      name: "summarize Q1 report",
      expected_mode: "skip",
      tool_sequence: [],
      scorers: [{ type: "tool-sequence" }],
      tags: [],
      ...overrides,
    };
  }

  it("carries the session id and agent through to the case", () => {
    const session = mkSession();
    const draft = extractSessionDraft(session);
    const c = buildGoldenCase(session, draft, answers(), NOW);

    expect(c.id).toBe("");
    expect(c.promoted_from_session).toBe("sess-abc");
    expect(c.agent_id).toBe("assistant");
    expect(c.input).toBe("Summarize the Q1 report.");
    expect(c.created_at).toEqual(NOW);
  });

  it("uses the actual run output when expected_mode is 'actual'", () => {
    const session = mkSession();
    const draft = extractSessionDraft(session);
    const c = buildGoldenCase(session, draft, answers({ expected_mode: "actual" }), NOW);
    expect(c.expected_output).toBe("Q1 revenue rose 12%.");
  });

  it("uses the custom expected output when expected_mode is 'custom'", () => {
    const session = mkSession();
    const draft = extractSessionDraft(session);
    const c = buildGoldenCase(
      session,
      draft,
      answers({ expected_mode: "custom", expected_output_custom: "Exactly this." }),
      NOW,
    );
    expect(c.expected_output).toBe("Exactly this.");
  });

  it("omits expected_output entirely when expected_mode is 'skip'", () => {
    const session = mkSession();
    const draft = extractSessionDraft(session);
    const c = buildGoldenCase(session, draft, answers({ expected_mode: "skip" }), NOW);
    expect("expected_output" in c).toBe(false);
  });

  it("only populates expected_tool_sequence when non-empty", () => {
    const session = mkSession();
    const draft = extractSessionDraft(session);

    const without = buildGoldenCase(session, draft, answers({ tool_sequence: [] }), NOW);
    expect("expected_tool_sequence" in without).toBe(false);

    const withSeq = buildGoldenCase(
      session,
      draft,
      answers({ tool_sequence: ["search", "fetch"] }),
      NOW,
    );
    expect(withSeq.expected_tool_sequence).toEqual(["search", "fetch"]);
  });

  it("only populates tags when non-empty", () => {
    const session = mkSession();
    const draft = extractSessionDraft(session);

    const without = buildGoldenCase(session, draft, answers({ tags: [] }), NOW);
    expect("tags" in without).toBe(false);

    const withTags = buildGoldenCase(session, draft, answers({ tags: ["smoke"] }), NOW);
    expect(withTags.tags).toEqual(["smoke"]);
  });

  it("passes scorers through verbatim, including custom with a path", () => {
    const session = mkSession();
    const draft = extractSessionDraft(session);
    const c = buildGoldenCase(
      session,
      draft,
      answers({
        scorers: [
          { type: "exact" },
          { type: "similarity", threshold: 0.9 },
          { type: "custom", path: "./scorers/business-rules.ts" },
        ],
      }),
      NOW,
    );
    expect(c.scorers).toHaveLength(3);
    expect(c.scorers[0]).toEqual({ type: "exact" });
    expect(c.scorers[1]).toEqual({ type: "similarity", threshold: 0.9 });
    expect(c.scorers[2]).toEqual({ type: "custom", path: "./scorers/business-rules.ts" });
  });
});

/* ========================================================================= */
/*  renderRecordedConfirmation                                                */
/* ========================================================================= */

describe("renderRecordedConfirmation", () => {
  it("shows the stored name, id, and the next-step hint", () => {
    const out = stripAnsi(
      renderRecordedConfirmation({
        id: "abc-123",
        name: "summarize Q1 report",
        agent_id: "assistant",
        input: "x",
        scorers: [],
        created_at: new Date(),
      }),
    );
    expect(out).toContain("Golden case saved: summarize Q1 report");
    expect(out).toContain("abc-123");
    expect(out).toContain("tutti-ai eval run");
  });
});
