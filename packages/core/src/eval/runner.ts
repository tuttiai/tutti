/** Evaluation runner — executes test suites against a score. */

import type { ScoreConfig, TuttiEvent } from "@tuttiai/types";
import { TuttiRuntime } from "../runtime.js";
import { logger } from "../logger.js";
import type {
  EvalCase,
  EvalSuite,
  EvalResult,
  EvalReport,
  EvalSummary,
  EvalAssertion,
  AssertionResult,
} from "./types.js";

// Sonnet-class pricing per million tokens
const INPUT_PER_M = 3;
const OUTPUT_PER_M = 15;

function estimateCost(inputTokens: number, outputTokens: number): number {
  return (inputTokens / 1_000_000) * INPUT_PER_M + (outputTokens / 1_000_000) * OUTPUT_PER_M;
}

export class EvalRunner {
  private runtime: TuttiRuntime;

  constructor(score: ScoreConfig) {
    this.runtime = new TuttiRuntime(score);
  }

  async run(suite: EvalSuite): Promise<EvalReport> {
    const results: EvalResult[] = [];

    for (const testCase of suite.cases) {
      const result = await this.runCase(testCase);
      results.push(result);
    }

    const summary = this.summarize(results);
    return { suite_name: suite.name, results, summary };
  }

  private async runCase(testCase: EvalCase): Promise<EvalResult> {
    const toolsCalled: string[] = [];
    const unsubscribeToolStart = this.runtime.events.on("tool:start", (e: TuttiEvent & { type: "tool:start" }) => {
      toolsCalled.push(e.tool_name);
    });

    const start = Date.now();
    let output = "";
    let turns = 0;
    let usage = { input_tokens: 0, output_tokens: 0 };
    let error: string | undefined;

    try {
      const result = await this.runtime.run(testCase.agent_id, testCase.input);
      output = result.output;
      turns = result.turns;
      usage = result.usage;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      output = "[error] " + error;
    }

    unsubscribeToolStart();

    const durationMs = Date.now() - start;
    const costUsd = estimateCost(usage.input_tokens, usage.output_tokens);

    const assertionResults = testCase.assertions.map((assertion) =>
      this.checkAssertion(assertion, output, toolsCalled, turns, costUsd),
    );

    const passedCount = assertionResults.filter((a) => a.passed).length;
    const score = testCase.assertions.length > 0
      ? passedCount / testCase.assertions.length
      : error ? 0 : 1;

    return {
      case_id: testCase.id,
      case_name: testCase.name,
      passed: assertionResults.every((a) => a.passed) && !error,
      score,
      output,
      turns,
      usage,
      cost_usd: costUsd,
      duration_ms: durationMs,
      assertions: assertionResults,
      error,
    };
  }

  private checkAssertion(
    assertion: EvalAssertion,
    output: string,
    toolsCalled: string[],
    turns: number,
    costUsd: number,
  ): AssertionResult {
    const val = assertion.value;

    switch (assertion.type) {
      case "contains":
        return {
          assertion,
          passed: output.toLowerCase().includes(String(val).toLowerCase()),
          actual: output.slice(0, 200),
        };

      case "not_contains":
        return {
          assertion,
          passed: !output.toLowerCase().includes(String(val).toLowerCase()),
          actual: output.slice(0, 200),
        };

      case "matches_regex": {
        // eslint-disable-next-line security/detect-non-literal-regexp -- pattern from eval assertion config, not user input
        const regex = new RegExp(String(val), "i");
        return {
          assertion,
          passed: regex.test(output),
          actual: output.slice(0, 200),
        };
      }

      case "tool_called":
        return {
          assertion,
          passed: toolsCalled.includes(String(val)),
          actual: toolsCalled.join(", ") || "(none)",
        };

      case "tool_not_called":
        return {
          assertion,
          passed: !toolsCalled.includes(String(val)),
          actual: toolsCalled.join(", ") || "(none)",
        };

      case "turns_lte":
        return {
          assertion,
          passed: turns <= Number(val),
          actual: turns,
        };

      case "cost_lte":
        return {
          assertion,
          passed: costUsd <= Number(val),
          actual: Number(costUsd.toFixed(4)),
        };

      default:
        logger.warn({ type: assertion.type }, "Unknown assertion type");
        return { assertion, passed: false, actual: "unknown assertion type" };
    }
  }

  private summarize(results: EvalResult[]): EvalSummary {
    const passed = results.filter((r) => r.passed).length;
    const scores = results.map((r) => r.score);
    const avgScore = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
    const totalCost = results.reduce((s, r) => s + r.cost_usd, 0);
    const totalDuration = results.reduce((s, r) => s + r.duration_ms, 0);

    return {
      total: results.length,
      passed,
      failed: results.length - passed,
      avg_score: Number(avgScore.toFixed(2)),
      total_cost_usd: Number(totalCost.toFixed(4)),
      total_duration_ms: totalDuration,
    };
  }
}
