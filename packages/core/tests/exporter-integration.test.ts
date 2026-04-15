import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { JsonFileExporter, configureExporter } from "@tuttiai/telemetry";

import { TuttiRuntime } from "../src/runtime.js";
import {
  createMockProvider,
  textResponse,
  toolUseResponse,
  simpleAgent,
} from "./helpers/mock-provider.js";
import type { ScoreConfig, Voice } from "@tuttiai/types";

describe("Span exporter integration with TuttiRuntime", () => {
  let tmpDir: string;
  let detach: () => Promise<void>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tutti-export-"));
    detach = async () => {};
  });

  afterEach(async () => {
    await detach();
    // Clean exporter slot so other tests in the suite aren't polluted.
    await configureExporter(undefined)();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes one JSON line per closed span when configured with JsonFileExporter", async () => {
    const path = join(tmpDir, "spans.jsonl");
    const exporter = new JsonFileExporter({ path });
    detach = configureExporter(exporter);

    // Mock agent with one tool call so we get all four span kinds:
    // agent.run, llm.completion (×2 — initial + post-tool), tool.call.
    const mathVoice: Voice = {
      name: "math",
      required_permissions: [],
      tools: [
        {
          name: "double",
          description: "Doubles a number",
          parameters: z.object({ x: z.number() }),
          execute: async (input: { x: number }) => ({
            content: `Result: ${input.x * 2}`,
          }),
        },
      ],
    };

    const provider = createMockProvider([
      toolUseResponse("double", { x: 21 }),
      textResponse("The answer is 42."),
    ]);

    const score: ScoreConfig = {
      provider,
      agents: {
        "test-agent": { ...simpleAgent, voices: [mathVoice], model: "gpt-4o" },
      },
    };

    const runtime = new TuttiRuntime(score);
    const result = await runtime.run("test-agent", "double 21");
    expect(result.output).toBe("The answer is 42.");

    // Force buffered writes to disk before reading.
    await detach();

    const content = readFileSync(path, "utf8").trim();
    const lines = content.split("\n");
    expect(lines.length).toBeGreaterThan(0);

    // Every line is valid JSON.
    const spans = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    for (const span of spans) {
      expect(typeof span.span_id).toBe("string");
      expect(typeof span.trace_id).toBe("string");
      expect(typeof span.name).toBe("string");
      expect(typeof span.started_at).toBe("string");
    }

    const names = new Set(spans.map((s) => s.name));
    // The runtime emits agent.run, llm.completion, and tool.call spans
    // around every run — assert they're all in the file.
    expect(names.has("agent.run")).toBe(true);
    expect(names.has("llm.completion")).toBe(true);
    expect(names.has("tool.call")).toBe(true);

    // Every span shares the same trace_id (the agent.run trace).
    const traceIds = new Set(spans.map((s) => s.trace_id));
    expect(traceIds.size).toBe(1);
    expect(traceIds.has(result.trace_id!)).toBe(true);
  });

  it("auto-installs JsonFileExporter when score.telemetry.jsonFile is set", async () => {
    const path = join(tmpDir, "auto.jsonl");
    const provider = createMockProvider([textResponse("hi")]);
    const score: ScoreConfig = {
      provider,
      agents: {
        "test-agent": { ...simpleAgent, model: "gpt-4o" },
      },
      telemetry: { enabled: false, jsonFile: path },
    };

    const runtime = new TuttiRuntime(score);
    await runtime.run("test-agent", "Hi");
    await runtime.shutdown();

    const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    const names = lines.map((l) => (JSON.parse(l) as { name: string }).name);
    expect(names).toContain("agent.run");
    expect(names).toContain("llm.completion");
  });

  it("TUTTI_TRACE_FILE env var beats score config", async () => {
    const envPath = join(tmpDir, "from-env.jsonl");
    const scorePath = join(tmpDir, "from-score.jsonl");

    process.env.TUTTI_TRACE_FILE = envPath;
    try {
      const provider = createMockProvider([textResponse("hi")]);
      const score: ScoreConfig = {
        provider,
        agents: { "test-agent": { ...simpleAgent, model: "gpt-4o" } },
        telemetry: { enabled: false, jsonFile: scorePath },
      };

      const runtime = new TuttiRuntime(score);
      await runtime.run("test-agent", "Hi");
      await runtime.shutdown();

      // Env-var file should exist; score-file path should not.
      expect(() => readFileSync(envPath, "utf8")).not.toThrow();
      expect(() => readFileSync(scorePath, "utf8")).toThrow(/ENOENT/);
    } finally {
      delete process.env.TUTTI_TRACE_FILE;
    }
  });

  it("score.telemetry.disabled wins over env vars and score-file otlp/jsonFile", async () => {
    const path = join(tmpDir, "should-not-exist.jsonl");
    process.env.TUTTI_TRACE_FILE = path;
    try {
      const provider = createMockProvider([textResponse("hi")]);
      const score: ScoreConfig = {
        provider,
        agents: { "test-agent": { ...simpleAgent, model: "gpt-4o" } },
        telemetry: { enabled: false, jsonFile: path, disabled: true },
      };

      const runtime = new TuttiRuntime(score);
      await runtime.run("test-agent", "Hi");
      await runtime.shutdown();

      expect(() => readFileSync(path, "utf8")).toThrow(/ENOENT/);
    } finally {
      delete process.env.TUTTI_TRACE_FILE;
    }
  });
});
