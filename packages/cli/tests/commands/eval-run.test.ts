/**
 * Integration tests for `tutti-ai eval run` — exercise the full
 * orchestration end-to-end by driving `runEvalRun` with a real
 * `JsonFileGoldenStore` on a tmpdir and an injected mock provider.
 *
 * Asserts: exit code signalling via the returned `failed` count, JUnit
 * XML file contents in `--ci` mode, summary stats (total / passed /
 * failed / tokens / cost), and filter plumbing (`--case`, `--tag`).
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ChatResponse,
  LLMProvider,
  ScoreConfig,
  StreamChunk,
} from "@tuttiai/types";
import { JsonFileGoldenStore, type GoldenCase } from "@tuttiai/core";

import { runEvalRun } from "../../src/commands/eval-run.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fixedProvider(text: string): LLMProvider {
  return {
    chat: vi.fn(
      async (): Promise<ChatResponse> => ({
        id: "r",
        content: [{ type: "text", text }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    ),
    async *stream(): AsyncGenerator<StreamChunk> {
      yield { type: "text", text };
      yield { type: "usage", usage: { input_tokens: 10, output_tokens: 5 }, stop_reason: "end_turn" };
    },
  };
}

function mkScore(provider: LLMProvider): ScoreConfig {
  return {
    provider,
    agents: {
      assistant: {
        name: "assistant",
        model: "test-model",
        system_prompt: "test",
        voices: [],
      },
    },
  };
}

async function seedCase(
  store: JsonFileGoldenStore,
  overrides: Partial<GoldenCase>,
): Promise<GoldenCase> {
  return store.saveCase({
    id: "",
    name: "unnamed",
    agent_id: "assistant",
    input: "hi",
    scorers: [{ type: "exact" }],
    created_at: new Date("2026-04-15T00:00:00Z"),
    ...overrides,
  });
}

// Silence per-case console.log output so test reporters aren't spammed.
const originalLog = console.log;
function silenceConsole(): void {
  console.log = () => undefined;
}
function restoreConsole(): void {
  console.log = originalLog;
}

// ---------------------------------------------------------------------------
// Fixture dir
// ---------------------------------------------------------------------------

describe("runEvalRun", () => {
  let dir: string;
  let store: JsonFileGoldenStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tutti-eval-run-"));
    store = new JsonFileGoldenStore(dir);
    silenceConsole();
  });

  afterEach(() => {
    restoreConsole();
    rmSync(dir, { recursive: true, force: true });
  });

  /* =========================================================== */
  /*  Summary stats                                               */
  /* =========================================================== */

  it("aggregates passed / failed / tokens / cost across every case", async () => {
    await seedCase(store, {
      name: "pass-case",
      expected_output: "hi",
      scorers: [{ type: "exact" }],
    });
    await seedCase(store, {
      name: "fail-case",
      expected_output: "never returned",
      scorers: [{ type: "exact" }],
    });

    const provider = fixedProvider("hi"); // only the pass-case matches
    const result = await runEvalRun({}, { score: mkScore(provider), store });

    expect(result.total).toBe(2);
    expect(result.passed).toBe(1);
    expect(result.failed).toBe(1);
    // Each run records 10 + 5 = 15 tokens → 30 total. cost_usd is
    // undefined on the mock so totalCostUsd stays 0.
    expect(result.totalTokens).toBe(30);
    expect(result.totalCostUsd).toBe(0);
    // No --ci → no XML file.
    expect(result.xmlPath).toBeUndefined();
  });

  /* =========================================================== */
  /*  CI mode + JUnit                                             */
  /* =========================================================== */

  it("in --ci mode writes JUnit XML with the expected structure", async () => {
    const passing = await seedCase(store, {
      name: "passer",
      expected_output: "hi",
      scorers: [{ type: "exact" }],
    });
    const failing = await seedCase(store, {
      name: "failer",
      expected_output: "other",
      scorers: [{ type: "exact" }],
    });

    const provider = fixedProvider("hi");
    const junitPath = join(dir, "eval-results.xml");
    const result = await runEvalRun(
      { ci: true },
      { score: mkScore(provider), store, junitPath },
    );

    expect(result.failed).toBe(1);
    expect(result.xmlPath).toBe(junitPath);

    const xml = readFileSync(junitPath, "utf8");
    expect(xml).toMatch(/<\?xml version="1\.0" encoding="UTF-8"\?>/);
    expect(xml).toMatch(/<testsuites[^>]*tests="2"/);
    expect(xml).toMatch(/<testsuites[^>]*failures="1"/);
    // Passing case renders as a self-closing testcase.
    expect(xml).toMatch(/<testcase[^>]*name="passer"[^>]*\/>/);
    // Failing case carries a <failure> body with the diff.
    expect(xml).toMatch(/<testcase[^>]*name="failer"[^>]*>/);
    expect(xml).toContain("<failure ");
    expect(xml).toContain("ScorerFailed");
    expect(xml).toContain("<![CDATA[");
    // Reference the cases so dead code doesn't accumulate in the fixture.
    expect(passing.id).toBeTruthy();
    expect(failing.id).toBeTruthy();
  });

  it("returns failed: 0 when every case passes (exit-0 signal)", async () => {
    await seedCase(store, {
      name: "only-passer",
      expected_output: "hi",
      scorers: [{ type: "exact" }],
    });
    const provider = fixedProvider("hi");
    const junitPath = join(dir, "out.xml");
    const result = await runEvalRun(
      { ci: true },
      { score: mkScore(provider), store, junitPath },
    );
    expect(result.failed).toBe(0);
    expect(result.passed).toBe(1);
    // XML is written even on a clean run — CI reporters want the green suite too.
    const xml = readFileSync(junitPath, "utf8");
    expect(xml).toMatch(/failures="0"/);
  });

  /* =========================================================== */
  /*  Filters                                                     */
  /* =========================================================== */

  it("filters by --case prefix", async () => {
    const keep = await seedCase(store, {
      name: "keep-me",
      expected_output: "hi",
      scorers: [{ type: "exact" }],
    });
    await seedCase(store, {
      name: "skip-me",
      expected_output: "hi",
      scorers: [{ type: "exact" }],
    });
    const provider = fixedProvider("hi");
    const result = await runEvalRun(
      { case: keep.id.slice(0, 8) },
      { score: mkScore(provider), store },
    );
    expect(result.total).toBe(1);
    expect(result.passed).toBe(1);
  });

  it("filters by --tag", async () => {
    await seedCase(store, {
      name: "smoke-case",
      tags: ["smoke"],
      expected_output: "hi",
      scorers: [{ type: "exact" }],
    });
    await seedCase(store, {
      name: "regression-case",
      tags: ["regression"],
      expected_output: "hi",
      scorers: [{ type: "exact" }],
    });
    const provider = fixedProvider("hi");
    const result = await runEvalRun(
      { tag: "smoke" },
      { score: mkScore(provider), store },
    );
    expect(result.total).toBe(1);
  });

  it("returns zeros and skips score loading when the filter matches nothing", async () => {
    await seedCase(store, { name: "x" });
    // No score injected — if the function tried to load one it'd crash
    // looking for ./tutti.score.ts. Hitting the empty-filter early-return
    // path means that never happens.
    const result = await runEvalRun(
      { case: "nonexistent-id" },
      { store },
    );
    expect(result).toEqual({
      passed: 0,
      failed: 0,
      total: 0,
      totalTokens: 0,
      totalCostUsd: 0,
    });
  });
});
