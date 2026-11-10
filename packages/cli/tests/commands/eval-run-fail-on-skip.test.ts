/**
 * End-to-end tests for `tutti-ai eval run --fail-on-skip`: a similarity
 * case run through `runEvalRun` with a real `JsonFileGoldenStore` on a
 * tmpdir, a mock provider, and either no `OPENAI_API_KEY` (the scorer
 * skips) or a fake embeddings client. No network and no real key.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatResponse, LLMProvider, ScoreConfig, StreamChunk } from "@tuttiai/types";
import { JsonFileGoldenStore, type EmbeddingsClient } from "@tuttiai/core";

import { runEvalRun } from "../../src/commands/eval-run.js";
import { shouldFailRun } from "../../src/commands/eval-run-skips.js";

function mkScore(text: string): ScoreConfig {
  const provider: LLMProvider = {
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
    },
  };
  return {
    provider,
    agents: {
      assistant: { name: "assistant", model: "test-model", system_prompt: "test", voices: [] },
    },
  };
}

const sameVectorClient: EmbeddingsClient = {
  create: async ({ input }) => ({ data: input.map(() => ({ embedding: [1, 0] })) }),
};

describe("runEvalRun --fail-on-skip", () => {
  const originalKey = process.env.OPENAI_API_KEY;
  const originalLog = console.log;
  let dir: string;
  let store: JsonFileGoldenStore;
  let lines: string[];

  beforeEach(async () => {
    delete process.env.OPENAI_API_KEY;
    dir = mkdtempSync(join(tmpdir(), "tutti-eval-skip-"));
    store = new JsonFileGoldenStore(dir);
    lines = [];
    console.log = (line: unknown) => {
      lines.push(String(line));
    };
    await store.saveCase({
      id: "",
      name: "greets",
      agent_id: "assistant",
      input: "hi",
      expected_output: "hi",
      scorers: [{ type: "similarity" }],
      created_at: new Date("2026-11-10T00:00:00Z"),
    });
  });

  afterEach(() => {
    console.log = originalLog;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
    rmSync(dir, { recursive: true, force: true });
  });

  it("no key, --ci --fail-on-skip: fails, and the JUnit failure names the case and scorer", async () => {
    const junitPath = join(dir, "out.xml");
    const opts = { ci: true, failOnSkip: true };
    const result = await runEvalRun(opts, { score: mkScore("hi"), store, junitPath });
    expect(result).toMatchObject({ passed: 0, failed: 1, skipped: 1 });
    expect(shouldFailRun(opts, result)).toBe(true);
    const xml = readFileSync(junitPath, "utf8");
    expect(xml).toContain('type="ScorerSkipped"');
    expect(xml).toContain("case &quot;greets&quot; skipped by scorer &quot;similarity&quot;");
    expect(lines).toContain("Skipped: 1 (failing run: --fail-on-skip)");
  });

  it("no key, --ci without the flag: passes as before and shows the skipped count", async () => {
    const junitPath = join(dir, "out.xml");
    const result = await runEvalRun({ ci: true }, { score: mkScore("hi"), store, junitPath });
    expect(result).toMatchObject({ passed: 1, failed: 0, skipped: 1 });
    expect(shouldFailRun({ ci: true }, result)).toBe(false);
    const xml = readFileSync(junitPath, "utf8");
    expect(xml).not.toContain("<failure");
    expect(xml).not.toContain("<skipped");
    expect(lines).toContain("Skipped: 1");
  });

  it("no key, --fail-on-skip without --ci: fails and writes no JUnit file", async () => {
    const opts = { failOnSkip: true };
    const result = await runEvalRun(opts, { score: mkScore("hi"), store });
    expect(result).toMatchObject({ failed: 1, skipped: 1 });
    expect(result.xmlPath).toBeUndefined();
    expect(shouldFailRun(opts, result)).toBe(true);
  });

  it("with a key and a fake client, --ci --fail-on-skip: unchanged and Skipped: 0", async () => {
    process.env.OPENAI_API_KEY = "sk-test-not-a-real-key";
    const junitPath = join(dir, "out.xml");
    const opts = { ci: true, failOnSkip: true };
    const deps = { score: mkScore("hi"), store, junitPath, embeddingsClient: sameVectorClient };
    const result = await runEvalRun(opts, deps);
    expect(result).toMatchObject({ passed: 1, failed: 0, skipped: 0 });
    expect(shouldFailRun(opts, result)).toBe(false);
    expect(readFileSync(junitPath, "utf8")).not.toContain("<failure");
    expect(lines).toContain("Skipped: 0");
    expect(lines.join("\n")).not.toContain("sk-test");
  });

  it("saves the scorer's own verdict, not the policy's failure", async () => {
    await runEvalRun({ failOnSkip: true }, { score: mkScore("hi"), store });
    const [saved] = await store.listCases();
    const runs = saved ? await store.listRuns(saved.id) : [];
    expect(runs[0]?.passed).toBe(true);
    expect(runs[0]?.scores["similarity"]?.skipped).toBe(true);
  });
});
