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
  VoiceError,
  PathTraversalError,
  UrlValidationError,
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

// Logger
export { createLogger, logger } from "./logger.js";

// Telemetry
export { TuttiTracer } from "./telemetry.js";
export { initTelemetry, shutdownTelemetry } from "./telemetry-setup.js";

// Runtime
export { TuttiRuntime } from "./runtime.js";
export { AgentRunner } from "./agent-runner.js";
export { AgentRouter } from "./agent-router.js";
export { EventBus } from "./event-bus.js";
export { InMemorySessionStore } from "./session-store.js";
export { PostgresSessionStore } from "./memory/postgres.js";
export { InMemorySemanticStore } from "./memory/in-memory-semantic.js";
export type { MemoryEntry, SemanticMemoryStore } from "./memory/semantic.js";
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
