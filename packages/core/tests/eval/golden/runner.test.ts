/**
 * Tests for the golden runner — drives GoldenCase through a mocked
 * provider, asserts the scorers, persistence, and diff computation
 * behave as advertised.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type {
  ChatResponse,
  LLMProvider,
  ScoreConfig,
  StreamChunk,
  Voice,
} from "@tuttiai/types";

import { JsonFileGoldenStore } from "../../../src/eval/golden/json-file-store.js";
import {
  GoldenRunner,
  computeDiff,
  runGoldenCase,
} from "../../../src/eval/golden/runner.js";
import type { GoldenCase } from "../../../src/eval/golden/types.js";
import type { EmbeddingsClient } from "../../../src/eval/scorers/similarity.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textResponse(text: string): ChatResponse {
  return {
    id: "resp-" + Math.random().toString(36).slice(2),
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

function toolUseThenTextProvider(toolNames: string[], finalText: string): LLMProvider {
  let n = 0;
  return {
    chat: vi.fn(async (): Promise<ChatResponse> => {
      if (n < toolNames.length) {
        const name = toolNames[n]!;
        n++;
        return {
          id: "resp-" + n,
          content: [{ type: "tool_use", id: "t" + n, name, input: {} }],
          stop_reason: "tool_use",
          usage: { input_tokens: 8, output_tokens: 2 },
        };
      }
      return textResponse(finalText);
    }),
    async *stream(): AsyncGenerator<StreamChunk> {
      yield { type: "text", text: finalText };
      yield { type: "usage", usage: { input_tokens: 0, output_tokens: 0 }, stop_reason: "end_turn" };
    },
  };
}

function noopVoice(toolNames: string[]): Voice {
  return {
    name: "test-voice",
    required_permissions: [],
    tools: toolNames.map((name) => ({
      name,
      description: "noop " + name,
      parameters: z.object({}),
      execute: () => Promise.resolve({ content: "ok:" + name }),
    })),
  };
}

function mkScore(provider: LLMProvider, toolNames: string[] = []): ScoreConfig {
  return {
    provider,
    agents: {
      assistant: {
        name: "assistant",
        model: "test-model",
        system_prompt: "test",
        voices: toolNames.length > 0 ? [noopVoice(toolNames)] : [],
      },
    },
  };
}

function mkCase(overrides: Partial<GoldenCase>): GoldenCase {
  return {
    id: "case-1",
    name: "sample",
    agent_id: "assistant",
    input: "hello?",
    scorers: [],
    created_at: new Date("2026-04-15T00:00:00.000Z"),
    ...overrides,
  };
}

const passingEmbeddings: EmbeddingsClient = {
  create: async ({ input }) => ({
    // Identical vectors → cosine 1 → passes at any threshold.
    data: input.map(() => ({ embedding: [1, 0, 0] })),
  }),
};

/* ========================================================================= */
/*  computeDiff                                                               */
/* ========================================================================= */

describe("computeDiff", () => {
  it("returns undefined when the case has no expected_output", () => {
    expect(computeDiff(mkCase({}), "anything")).toBeUndefined();
  });

  it("returns undefined when actual matches expected exactly", () => {
    expect(
      computeDiff(mkCase({ expected_output: "same" }), "same"),
    ).toBeUndefined();
  });

  it("returns a unified-format patch labelled 'expected' / 'actual'", () => {
    const diff = computeDiff(
      mkCase({ expected_output: "line a\nline b\n" }),
      "line a\nline c\n",
    );
    expect(diff).toBeDefined();
    expect(diff!).toContain("--- expected");
    expect(diff!).toContain("+++ actual");
    expect(diff!).toContain("-line b");
    expect(diff!).toContain("+line c");
  });
});

/* ========================================================================= */
/*  GoldenRunner.runGoldenCase                                                */
/* ========================================================================= */

describe("GoldenRunner.runGoldenCase", () => {
  it("runs the agent, records the output, and scores a passing exact case", async () => {
    const provider = toolUseThenTextProvider([], "Paris");
    const runner = new GoldenRunner({ score: mkScore(provider) });

    const run = await runner.runGoldenCase(
      mkCase({
        input: "Capital of France?",
        expected_output: "Paris",
        scorers: [{ type: "exact" }],
      }),
    );

    expect(run.output).toBe("Paris");
    expect(run.case_id).toBe("case-1");
    expect(run.ran_at).toBeInstanceOf(Date);
    expect(run.passed).toBe(true);
    expect(run.scores["exact"]?.passed).toBe(true);
    expect(run.diff).toBeUndefined();
  });

  it("populates diff when the output differs from expected_output", async () => {
    const provider = toolUseThenTextProvider([], "London");
    const runner = new GoldenRunner({ score: mkScore(provider) });

    const run = await runner.runGoldenCase(
      mkCase({
        expected_output: "Paris",
        scorers: [{ type: "exact" }],
      }),
    );

    expect(run.passed).toBe(false);
    expect(run.diff).toBeDefined();
    expect(run.diff!).toContain("-Paris");
    expect(run.diff!).toContain("+London");
  });

  it("captures the ordered tool sequence from tool:start events", async () => {
    const provider = toolUseThenTextProvider(["search", "fetch"], "done");
    const runner = new GoldenRunner({
      score: mkScore(provider, ["search", "fetch"]),
    });

    const run = await runner.runGoldenCase(
      mkCase({
        scorers: [{ type: "tool-sequence" }],
        expected_tool_sequence: ["search", "fetch"],
      }),
    );

    expect(run.tool_sequence).toEqual(["search", "fetch"]);
    expect(run.scores["tool-sequence"]?.passed).toBe(true);
    expect(run.passed).toBe(true);
  });

  it("overall passed is false when ANY scorer fails", async () => {
    const provider = toolUseThenTextProvider([], "Paris");
    const runner = new GoldenRunner({ score: mkScore(provider) });

    const run = await runner.runGoldenCase(
      mkCase({
        expected_output: "Paris",
        expected_tool_sequence: ["must_call"],
        scorers: [{ type: "exact" }, { type: "tool-sequence" }],
      }),
    );

    expect(run.scores["exact"]?.passed).toBe(true);
    expect(run.scores["tool-sequence"]?.passed).toBe(false);
    expect(run.passed).toBe(false);
  });

  it("reports the total token count (input + output) on the run", async () => {
    const provider = toolUseThenTextProvider([], "hi");
    const runner = new GoldenRunner({ score: mkScore(provider) });
    const run = await runner.runGoldenCase(
      mkCase({ scorers: [] }),
    );
    // textResponse returns 10 + 5.
    expect(run.tokens).toBeGreaterThanOrEqual(15);
  });

  it("persists the run via the optional store and returns the stored record", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tutti-golden-runner-"));
    try {
      const store = new JsonFileGoldenStore(dir);
      const saved = await store.saveCase(
        mkCase({ id: "", expected_output: "hi", scorers: [{ type: "exact" }] }),
      );

      const provider = toolUseThenTextProvider([], "hi");
      const runner = new GoldenRunner({ score: mkScore(provider), store });

      const run = await runner.runGoldenCase({ ...saved });

      expect(run.id).toMatch(/^[0-9a-f-]{36}$/); // store assigned one
      const listed = await store.listRuns(saved.id);
      expect(listed).toHaveLength(1);
      expect(listed[0]!.id).toBe(run.id);
      expect(listed[0]!.passed).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("routes the injected embeddings client into SimilarityScorer", async () => {
    const provider = toolUseThenTextProvider([], "actual");
    const runner = new GoldenRunner({
      score: mkScore(provider),
      embeddingsClient: passingEmbeddings,
    });
    const run = await runner.runGoldenCase(
      mkCase({
        expected_output: "different wording",
        scorers: [{ type: "similarity", threshold: 0.5 }],
      }),
    );
    expect(run.scores["similarity"]?.passed).toBe(true);
    expect(run.scores["similarity"]?.score).toBeCloseTo(1, 9);
  });

  it("captures agent errors as a [error] prefix in the run output", async () => {
    const provider: LLMProvider = {
      chat: () => Promise.reject(new Error("boom")),
      // eslint-disable-next-line require-yield -- stream is not exercised but required by the interface
      async *stream(): AsyncGenerator<StreamChunk> {
        throw new Error("boom");
      },
    };
    const runner = new GoldenRunner({ score: mkScore(provider) });
    const run = await runner.runGoldenCase(
      mkCase({ scorers: [{ type: "exact" }], expected_output: "whatever" }),
    );
    expect(run.output.startsWith("[error]")).toBe(true);
    expect(run.passed).toBe(false);
  });
});

/* ========================================================================= */
/*  runGoldenCase sugar function                                              */
/* ========================================================================= */

describe("runGoldenCase (function form)", () => {
  it("wraps GoldenRunner for a single-shot call", async () => {
    const provider = toolUseThenTextProvider([], "answer");
    const run = await runGoldenCase(
      mkCase({ expected_output: "answer", scorers: [{ type: "exact" }] }),
      { score: mkScore(provider) },
    );
    expect(run.passed).toBe(true);
    expect(run.output).toBe("answer");
  });
});
