import { describe, it, expect } from "vitest";
import { EvalRunner } from "../src/eval/runner.js";
import { printTable, toJSON, toMarkdown } from "../src/eval/report.js";
import type { EvalSuite, EvalReport } from "../src/eval/types.js";
import type { ScoreConfig, LLMProvider, ChatRequest, ChatResponse, StreamChunk } from "@tuttiai/types";

function fakeProvider(text: string, toolNames: string[] = []): LLMProvider {
  let callNum = 0;
  return {
    async chat(): Promise<ChatResponse> {
      callNum++;
      if (callNum <= toolNames.length) {
        return {
          id: "r" + callNum,
          content: [{ type: "tool_use", id: "t" + callNum, name: toolNames[callNum - 1], input: {} }],
          stop_reason: "tool_use",
          usage: { input_tokens: 10, output_tokens: 5 },
        };
      }
      return {
        id: "rfinal",
        content: [{ type: "text", text }],
        stop_reason: "end_turn",
        usage: { input_tokens: 20, output_tokens: 10 },
      };
    },
    async *stream(): AsyncGenerator<StreamChunk> {
      yield { type: "text", text };
      yield { type: "usage", usage: { input_tokens: 20, output_tokens: 10 }, stop_reason: "end_turn" };
    },
  };
}

function makeScore(provider: LLMProvider): ScoreConfig {
  return {
    provider,
    agents: {
      assistant: {
        name: "assistant",
        model: "test-model",
        system_prompt: "You are a test assistant.",
        voices: [],
      },
    },
  };
}

describe("EvalRunner", () => {
  it("passes when all assertions match", async () => {
    const provider = fakeProvider("The capital of France is Paris.");
    const score = makeScore(provider);
    const runner = new EvalRunner(score);

    const suite: EvalSuite = {
      name: "test",
      cases: [{
        id: "t1",
        name: "Capital test",
        agent_id: "assistant",
        input: "Capital of France?",
        assertions: [
          { type: "contains", value: "Paris" },
          { type: "not_contains", value: "London" },
          { type: "turns_lte", value: 5 },
        ],
      }],
    };

    const report = await runner.run(suite);

    expect(report.results).toHaveLength(1);
    expect(report.results[0].passed).toBe(true);
    expect(report.results[0].score).toBe(1);
    expect(report.summary.passed).toBe(1);
    expect(report.summary.failed).toBe(0);
  });

  it("fails when assertion does not match", async () => {
    const provider = fakeProvider("The capital is Paris.");
    const runner = new EvalRunner(makeScore(provider));

    const suite: EvalSuite = {
      name: "fail-test",
      cases: [{
        id: "t2",
        name: "Expects London",
        agent_id: "assistant",
        input: "test",
        assertions: [
          { type: "contains", value: "London" },
          { type: "contains", value: "Paris" },
        ],
      }],
    };

    const report = await runner.run(suite);

    expect(report.results[0].passed).toBe(false);
    expect(report.results[0].score).toBe(0.5);
    expect(report.results[0].assertions[0].passed).toBe(false);
    expect(report.results[0].assertions[1].passed).toBe(true);
  });

  it("checks matches_regex assertion", async () => {
    const provider = fakeProvider("Hello! I am your assistant.");
    const runner = new EvalRunner(makeScore(provider));

    const suite: EvalSuite = {
      name: "regex-test",
      cases: [{
        id: "t3",
        name: "Regex match",
        agent_id: "assistant",
        input: "hi",
        assertions: [
          // Pattern matches output capitalization directly (no implicit case-insensitivity)
          { type: "matches_regex", value: "Hello.*assistant" },
        ],
      }],
    };

    const report = await runner.run(suite);
    expect(report.results[0].passed).toBe(true);
  });

  it("checks cost_lte assertion with exact cost calculation", async () => {
    const provider = fakeProvider("cheap response");
    const runner = new EvalRunner(makeScore(provider));

    // Expected: 20 input tokens × $3/1M + 10 output tokens × $15/1M = 0.00006 + 0.00015 = 0.00021
    const INPUT_PER_M = 3;
    const OUTPUT_PER_M = 15;
    const expectedCost = (20 / 1_000_000) * INPUT_PER_M + (10 / 1_000_000) * OUTPUT_PER_M;

    const suite: EvalSuite = {
      name: "cost-test",
      cases: [{
        id: "t4",
        name: "Low cost",
        agent_id: "assistant",
        input: "test",
        assertions: [
          { type: "cost_lte", value: 0.001 },
          // Budget below actual cost should fail
          { type: "cost_lte", value: 0.0001 },
        ],
      }],
    };

    const report = await runner.run(suite);
    // First assertion passes (actual cost < 0.001), second fails (actual cost > 0.0001)
    expect(report.results[0].assertions[0].passed).toBe(true);
    expect(report.results[0].assertions[1].passed).toBe(false);
    // Verify the cost matches the exact pricing formula
    expect(report.results[0].cost_usd).toBeCloseTo(expectedCost, 6);
  });

  it("calculates summary correctly", async () => {
    const provider = fakeProvider("result");
    const runner = new EvalRunner(makeScore(provider));

    const suite: EvalSuite = {
      name: "multi",
      cases: [
        {
          id: "a",
          name: "Pass",
          agent_id: "assistant",
          input: "test",
          assertions: [{ type: "contains", value: "result" }],
        },
        {
          id: "b",
          name: "Fail",
          agent_id: "assistant",
          input: "test",
          assertions: [{ type: "contains", value: "nonexistent" }],
        },
      ],
    };

    const report = await runner.run(suite);

    expect(report.summary.total).toBe(2);
    expect(report.summary.passed).toBe(1);
    expect(report.summary.failed).toBe(1);
    expect(report.summary.avg_score).toBe(0.5);
  });
});

describe("EvalReport formatters", () => {
  const report: EvalReport = {
    suite_name: "Test Suite",
    results: [
      {
        case_id: "t1",
        case_name: "Passes",
        passed: true,
        score: 1,
        output: "Paris",
        turns: 1,
        usage: { input_tokens: 20, output_tokens: 10 },
        cost_usd: 0.003,
        duration_ms: 500,
        assertions: [{ assertion: { type: "contains", value: "Paris" }, passed: true, actual: "Paris" }],
      },
      {
        case_id: "t2",
        case_name: "Fails",
        passed: false,
        score: 0,
        output: "Paris",
        turns: 3,
        usage: { input_tokens: 50, output_tokens: 30 },
        cost_usd: 0.012,
        duration_ms: 1200,
        assertions: [{ assertion: { type: "contains", value: "London" }, passed: false, actual: "Paris" }],
      },
    ],
    summary: { total: 2, passed: 1, failed: 1, avg_score: 0.5, total_cost_usd: 0.015, total_duration_ms: 1700 },
  };

  it("toJSON produces valid JSON", () => {
    const json = toJSON(report);
    const parsed = JSON.parse(json);
    expect(parsed.suite_name).toBe("Test Suite");
    expect(parsed.results).toHaveLength(2);
  });

  it("toMarkdown produces a table with headers", () => {
    const md = toMarkdown(report);
    expect(md).toContain("## Eval: Test Suite");
    expect(md).toContain("| Status |");
    expect(md).toContain("| pass | t1 |");
    expect(md).toContain("| FAIL | t2 |");
    expect(md).toContain("### Failures");
  });

  it("printTable outputs suite name, case names, scores, and summary", () => {
    const output: string[] = [];
    const originalLog = console.log;
    console.log = (msg?: unknown) => { output.push(typeof msg === "string" ? msg : String(msg)); };

    try {
      printTable(report);
    } finally {
      console.log = originalLog;
    }

    const full = output.join("\n");
    // Suite header
    expect(full).toContain("Test Suite");
    expect(full).toContain("2 cases");
    // Case names
    expect(full).toContain("Passes");
    expect(full).toContain("Fails");
    // Case IDs
    expect(full).toContain("t1");
    expect(full).toContain("t2");
    // Scores formatted to 2 decimals
    expect(full).toContain("1.00");
    expect(full).toContain("0.00");
    // Summary line
    expect(full).toContain("1/2 passed (50%)");
    expect(full).toContain("Avg: 0.50");
    expect(full).toContain("Total: $0.015");
    // Failed assertion detail
    expect(full).toContain("FAIL");
    expect(full).toContain("contains: London");
  });
});
