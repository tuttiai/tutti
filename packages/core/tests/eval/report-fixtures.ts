import type { EvalReport, EvalResult } from "../../src/eval/types.js";

const usage = { input_tokens: 20, output_tokens: 10 };

/** A case that passed every assertion. */
export const passResult: EvalResult = {
  case_id: "t1",
  case_name: "Passes",
  passed: true,
  score: 1,
  output: "Paris",
  turns: 1,
  usage,
  cost_usd: 0.003,
  duration_ms: 500,
  assertions: [{ assertion: { type: "contains", value: "Paris" }, passed: true, actual: "Paris" }],
};

/** A case with one passing and two failing assertions, one with a description. */
export const failResult: EvalResult = {
  case_id: "t2",
  case_name: "Fails",
  passed: false,
  score: 0.25,
  output: "Paris",
  turns: 3,
  usage,
  cost_usd: 0.012,
  duration_ms: 1200,
  assertions: [
    { assertion: { type: "contains", value: "London" }, passed: false, actual: "Paris" },
    { assertion: { type: "turns_lte", value: 5 }, passed: true, actual: 3 },
    {
      assertion: { type: "matches_regex", value: "^ok$", description: "answers ok" },
      passed: false,
      actual: "x".repeat(70),
    },
  ],
};

/** A case that errored before any assertion ran, with an error over 80 characters. */
export const errorResult: EvalResult = {
  case_id: "a-very-long-case-id",
  case_name: "Errors with a case name that is longer than twenty-eight characters",
  passed: false,
  score: 0,
  output: "",
  turns: 0,
  usage: { input_tokens: 0, output_tokens: 0 },
  cost_usd: 0,
  duration_ms: 10,
  assertions: [],
  error: "Provider failed: " + "e".repeat(90),
};

/** Build a report around the given results with a fixed summary. */
function reportOf(results: EvalResult[], passed: number, avg: number): EvalReport {
  const total_cost_usd = results.reduce((sum, r) => sum + r.cost_usd, 0);
  return {
    suite_name: "Test Suite",
    results,
    summary: {
      total: results.length,
      passed,
      failed: results.length - passed,
      avg_score: avg,
      total_cost_usd,
      total_duration_ms: 0,
    },
  };
}

export const passReport = reportOf([passResult], 1, 1);
export const failReport = reportOf([failResult], 0, 0.25);
export const errorReport = reportOf([errorResult], 0, 0);
export const emptyReport = reportOf([], 0, 0);
export const mixedReport = reportOf([passResult, failResult, errorResult], 1, 1.25 / 3);
