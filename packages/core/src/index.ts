// Errors
export {
  TuttiError,
  ScoreValidationError,
  AgentNotFoundError,
  PermissionError,
  BudgetExceededError,
  ToolTimeoutError,
  ProviderError,
  AuthenticationError,
  RateLimitError,
  ContextWindowError,
  GuardrailError,
  StructuredOutputError,
  VoiceError,
  PathTraversalError,
  UrlValidationError,
  InterruptDeniedError,
} from "./errors.js";

// Hooks
export {
  createLoggingHook,
  createCacheHook,
  createBlocklistHook,
  createMaxCostHook,
} from "./hooks/index.js";

// Eval
export {
  EvalRunner,
  printTable as printEvalTable,
  toJSON as evalToJSON,
  toMarkdown as evalToMarkdown,
} from "./eval/index.js";
export type {
  EvalAssertion,
  EvalCase,
  EvalSuite,
  EvalResult,
  EvalReport,
  EvalSummary,
} from "./eval/index.js";

// Golden dataset storage (eval v2 regression layer)
export {
  DEFAULT_GOLDEN_BASE_PATH,
  JsonFileGoldenStore,
} from "./eval/index.js";
export type {
  GoldenCase,
  GoldenRun,
  ScorerRef,
  ScoreResult,
  GoldenStore,
} from "./eval/index.js";

// Logger
export { createLogger, logger } from "./logger.js";

// Telemetry
export { getTuttiTracer, getCurrentTraceId, getCurrentSpanId } from "./telemetry.js";
export {
  TuttiTracer,
  MODEL_PRICES,
  JsonFileExporter,
  OTLPExporter,
  buildTraceSummaries,
  configureExporter,
  estimateCost,
  getActiveExporter,
  getRunCost,
  registerModelPrice,
} from "@tuttiai/telemetry";
export type {
  TuttiSpan,
  TuttiSpanAttributes,
  TuttiSpanError,
  SpanKind,
  SpanStatus,
  SpanSubscriber,
  GuardrailAction,
  JsonFileExporterOptions,
  ModelPrice,
  OTLPExporterOptions,
  RunCost,
  SpanExporter,
  TraceSummary,
} from "@tuttiai/telemetry";
export { initTelemetry, shutdownTelemetry } from "./telemetry-setup.js";

// Runtime
export { TuttiRuntime, type TuttiRuntimeOptions } from "./runtime.js";
export { AgentRunner } from "./agent-runner.js";
export { AgentRouter } from "./agent-router.js";
export { EventBus } from "./event-bus.js";
export { InMemorySessionStore } from "./session-store.js";
export { PostgresSessionStore } from "./memory/postgres.js";
export { InMemorySemanticStore } from "./memory/in-memory-semantic.js";
export type { MemoryEntry, SemanticMemoryStore } from "./memory/semantic.js";
export {
  DEFAULT_MAX_MEMORIES_PER_USER,
  MemoryUserMemoryStore,
  PostgresUserMemoryStore,
  createUserMemoryStore,
} from "./memory/user/index.js";

// Human-in-the-loop interrupts
export {
  MemoryInterruptStore,
  PostgresInterruptStore,
  globMatch,
  matchesAny,
  needsApproval,
  type InterruptCreateInput,
  type InterruptRequest,
  type InterruptStatus,
  type InterruptStore,
  type PostgresInterruptStoreOptions,
  type ResolveOptions,
} from "./interrupt/index.js";
export type {
  AgentRunOptions,
  MemoryUserMemoryStoreOptions,
  PostgresUserMemoryStoreOptions,
  StoreOptions,
  UserMemory,
  UserMemoryImportance,
  UserMemorySource,
  UserMemoryStore,
} from "./memory/user/index.js";
export { ScoreLoader } from "./score-loader.js";
export { defineScore } from "./define-score.js";
export { SecretsManager } from "./secrets.js";
export { PermissionGuard } from "./permission-guard.js";
export { PromptGuard } from "./prompt-guard.js";
export { TokenBudget } from "./token-budget.js";
export { validateScore } from "./score-schema.js";

// Checkpoint persistence
export type {
  Checkpoint,
  SessionState,
  CheckpointStore,
  RedisCheckpointStoreOptions,
  PostgresCheckpointStoreOptions,
} from "./checkpoint/index.js";
export {
  MemoryCheckpointStore,
  RedisCheckpointStore,
  PostgresCheckpointStore,
  createCheckpointStore,
  DEFAULT_CHECKPOINT_TTL_SECONDS,
} from "./checkpoint/index.js";

// Tool result cache
export type { ToolCache } from "./cache/tool-cache.js";
export {
  InMemoryToolCache,
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_CACHE_MAX_ENTRIES,
} from "./cache/in-memory-cache.js";
export type { InMemoryToolCacheOptions } from "./cache/in-memory-cache.js";
export { DEFAULT_WRITE_TOOLS } from "./cache/index.js";

// Scheduler
export {
  SchedulerEngine,
  MemoryScheduleStore,
  PostgresScheduleStore,
  parseInterval,
  validateCron,
} from "./scheduler/index.js";
export type {
  ScheduleConfig,
  ScheduledRun,
  ScheduleRecord,
  ScheduleStore,
  PostgresScheduleStoreOptions,
} from "./scheduler/index.js";

// Guardrails
export {
  profanityFilter,
  piiDetector,
  topicBlocker,
} from "./guardrails/index.js";
export type {
  ProfanityFilterOptions,
  TopicBlockerOptions,
} from "./guardrails/index.js";

// Graph execution engine
export { TuttiGraph, END, defineGraph, GraphBuilder } from "./graph/index.js";
export {
  GraphValidationError,
  GraphCycleError,
  GraphDeadEndError,
  GraphStateError,
} from "./graph/index.js";
export { renderGraph, graphToJSON } from "./graph/index.js";
export type {
  GraphConfig,
  GraphEdge,
  GraphEvent,
  GraphNode,
  GraphRunResult,
  NodeResult,
  RunOptions as GraphRunOptions,
  EdgeOptions,
  NodeOptions,
} from "./graph/index.js";

// Providers
export { AnthropicProvider } from "./providers/anthropic.js";
export type { AnthropicProviderOptions } from "./providers/anthropic.js";
export { OpenAIProvider } from "./providers/openai.js";
export type { OpenAIProviderOptions } from "./providers/openai.js";
export { GeminiProvider } from "./providers/gemini.js";
export type { GeminiProviderOptions } from "./providers/gemini.js";

// Re-export all types for convenience
export type {
  // LLM
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
  ContentBlock,
  ChatMessage,
  StopReason,
  ToolDefinition,
  ChatRequest,
  ChatResponse,
  TokenUsage,
  StreamChunk,
  LLMProvider,
  // Voice
  Permission,
  ToolResult,
  ToolMemoryHelpers,
  ToolContext,
  Tool,
  VoiceContext,
  Voice,
  // Agent
  BudgetConfig,
  AgentMemoryConfig,
  AgentCacheConfig,
  AgentScheduleConfig,
  RunContext,
  GuardrailHook,
  AgentConfig,
  AgentResult,
  ParallelAgentResult,
  // Score
  MemoryConfig,
  TelemetryConfig,
  ScoreConfig,
  ParallelEntryConfig,
  // Session
  Session,
  SessionStore,
  // Events
  TuttiEvent,
  TuttiEventType,
  TuttiEventHandler,
  // Hooks
  HookContext,
  TuttiHooks,
} from "@tuttiai/types";
