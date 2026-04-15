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
  GoldenRunnerOptions,
} from "./golden/index.js";
export {
  DEFAULT_GOLDEN_BASE_PATH,
  JsonFileGoldenStore,
  GoldenRunner,
  computeDiff,
  runGoldenCase,
} from "./golden/index.js";

// Golden scorers (exact / similarity / tool-sequence / custom).
export type {
  Scorer,
  ScorerInput,
  SimilarityScorerOptions,
  EmbeddingsClient,
  CustomScorerFn,
  ScorerRegistryOptions,
} from "./scorers/index.js";
export {
  ExactScorer,
  SimilarityScorer,
  ToolSequenceScorer,
  CustomScorer,
  resolveScorer,
  normalizeForExactMatch,
  cosineSimilarity,
  countOrderedMatches,
  DEFAULT_SIMILARITY_THRESHOLD,
  DEFAULT_EMBEDDING_MODEL,
} from "./scorers/index.js";
