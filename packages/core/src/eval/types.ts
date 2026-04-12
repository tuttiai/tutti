/** Evaluation framework types. */

import type { TokenUsage } from "@tuttiai/types";

export interface EvalAssertion {
  type:
    | "contains"
    | "not_contains"
    | "matches_regex"
    | "tool_called"
    | "tool_not_called"
    | "turns_lte"
    | "cost_lte";
  value: string | number;
  description?: string;
}

export interface EvalCase {
  id: string;
  name: string;
  agent_id: string;
  input: string;
  assertions: EvalAssertion[];
}

export interface EvalSuite {
  name: string;
  cases: EvalCase[];
}

export interface AssertionResult {
  assertion: EvalAssertion;
  passed: boolean;
  actual: string | number;
}

export interface EvalResult {
  case_id: string;
  case_name: string;
  passed: boolean;
  score: number;
  output: string;
  turns: number;
  usage: TokenUsage;
  cost_usd: number;
  duration_ms: number;
  assertions: AssertionResult[];
  error?: string;
}

export interface EvalSummary {
  total: number;
  passed: number;
  failed: number;
  avg_score: number;
  total_cost_usd: number;
  total_duration_ms: number;
}

export interface EvalReport {
  suite_name: string;
  results: EvalResult[];
  summary: EvalSummary;
}
