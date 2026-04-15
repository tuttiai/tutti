export type {
  EvalAssertion,
  EvalCase,
  EvalSuite,
  EvalResult,
  EvalReport,
  EvalSummary,
  AssertionResult,
} from "./types.js";
export { EvalRunner } from "./runner.js";
export { printTable, toJSON, toMarkdown } from "./report.js";

// Golden dataset storage — v2 eval regression layer.
export type {
  GoldenCase,
  GoldenRun,
  ScorerRef,
  ScoreResult,
  GoldenStore,
} from "./golden/index.js";
export {
  DEFAULT_GOLDEN_BASE_PATH,
  JsonFileGoldenStore,
} from "./golden/index.js";
