/** Agent configuration and result types. */

import type { ZodType } from "zod";
import type { ChatMessage, TokenUsage } from "./llm.js";
import type { Permission } from "./voice.js";
import type { Voice } from "./voice.js";
import type { TuttiHooks } from "./hooks.js";

export interface BudgetConfig {
  max_tokens?: number;
  max_cost_usd?: number;
  /** Percentage at which to emit a warning (default 80). */
  warn_at_percent?: number;
}

export interface AgentMemoryConfig {
  /** Enable semantic memory for this agent. */
  enabled: boolean;
  /** Max memory entries to inject per LLM call (default 5). */
  max_memories?: number;
  /** Inject memories into the system prompt (default true). */
  inject_system?: boolean;
}

/**
 * Per-agent durable-checkpoint configuration.
 *
 * When enabled, the runtime persists a {@link Checkpoint} at every turn
 * boundary so a crashed or restarted process can resume the conversation
 * exactly where it left off. `true` accepts the defaults; an object lets
 * the caller pick the backing store and override the retention window.
 */
export interface AgentDurableConfig {
  /** Which checkpoint store to write to. */
  store: "redis" | "postgres" | "memory";
  /**
   * Checkpoint TTL in seconds. When omitted, `createCheckpointStore`
   * (in `@tuttiai/core`) substitutes its `DEFAULT_CHECKPOINT_TTL_SECONDS`
   * constant — currently 604800 (7 days). The default is applied by the
   * factory, not by this interface; a `CheckpointStore` constructed
   * directly may define its own default.
   */
  ttl?: number;
}

/**
 * Per-agent tool result cache configuration.
 *
 * When `enabled`, repeated tool calls with the same input within `ttl_ms`
 * are served from cache and emit a `cache:hit` event. Known write /
 * side-effect tools (write_file, delete_file, move_file, create_issue,
 * comment_on_issue) are always excluded regardless of this setting;
 * callers can add more via `excluded_tools`. Errored results
 * (`is_error: true`) are never cached, so transient failures don't get
 * pinned.
 */
export interface AgentCacheConfig {
  enabled: boolean;
  /** Per-agent TTL override in milliseconds. Falls back to the cache default (5 min). */
  ttl_ms?: number;
  /** Tool names to exclude in addition to the built-in write-tool list. */
  excluded_tools?: string[];
}

/**
 * Context passed to {@link AgentConfig.beforeRun} and {@link AgentConfig.afterRun}
 * guardrail hooks, giving them access to the agent name and session.
 */
export interface RunContext {
  agent_name: string;
  session_id: string;
}

/**
 * Guardrail hook signature. Returns a replacement string, void for no change,
 * or throws a `GuardrailError` to abort the run.
 */
export type GuardrailHook = (text: string, context: RunContext) => Promise<string | void>;

export interface AgentConfig {
  name: string;
  description?: string;
  model?: string;
  system_prompt: string;
  voices: Voice[];
  permissions?: Permission[];
  max_turns?: number;
  max_tool_calls?: number;
  tool_timeout_ms?: number;
  budget?: BudgetConfig;
  /** Semantic (long-term) memory configuration. */
  semantic_memory?: AgentMemoryConfig;
  /** Enable token-by-token streaming (default: false). */
  streaming?: boolean;
  /** Allow the agent to pause and ask the human for input (default: false). */
  allow_human_input?: boolean;
  /** Agent IDs this agent can delegate to via the orchestrator. */
  delegates?: string[];
  /** Role in the orchestration — orchestrator receives input first. */
  role?: "orchestrator" | "specialist";
  /** Agent-level lifecycle hooks — merged with global hooks from ScoreConfig. */
  hooks?: TuttiHooks;
  /** Tool result cache — serves repeated identical tool calls from memory. */
  cache?: AgentCacheConfig;
  /**
   * Persist a checkpoint at every turn boundary so crashed or restarted
   * processes can resume without losing progress. `true` accepts defaults
   * (memory store, 7-day TTL); pass an object to pick the backing store
   * or override the retention window.
   */
  durable?: boolean | AgentDurableConfig;
  /**
   * When set, the agent's final text output is validated against this Zod
   * schema. The runtime appends a JSON-schema instruction to the system
   * prompt and retries on parse failure up to {@link maxRetries} times.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  outputSchema?: ZodType<unknown, any, any>;
  /**
   * Maximum validation retries for structured output (default 3).
   * Only used when {@link outputSchema} is set.
   */
  maxRetries?: number;
  /**
   * Input guardrail — called on the raw user input before any turn.
   * Return a replacement string to modify, void to pass through,
   * or throw `GuardrailError` to abort the run.
   */
  beforeRun?: GuardrailHook;
  /**
   * Output guardrail — called on the final text output after the last turn.
   * Return a replacement string to modify, void to pass through,
   * or throw `GuardrailError` to abort the run.
   */
  afterRun?: GuardrailHook;
}

export interface AgentResult {
  session_id: string;
  output: string;
  messages: ChatMessage[];
  turns: number;
  usage: TokenUsage;
  /** Parsed structured output — present when {@link AgentConfig.outputSchema} is set and validation succeeds. */
  structured?: unknown;
}

/**
 * Aggregate result returned when several agents are run simultaneously via
 * `AgentRouter.runParallel()` (or when a score's `entry` is a parallel
 * configuration). Contains each agent's individual result plus rollup metrics.
 */
export interface ParallelAgentResult {
  /** Individual results, keyed by agent_id. */
  results: Map<string, AgentResult>;
  /** Concatenated outputs with `[agent_id]` labels for quick display. */
  merged_output: string;
  /** Sum of token usage across every agent that completed. */
  total_usage: TokenUsage;
  /** Estimated total cost in USD across every agent that completed. */
  total_cost_usd: number;
  /** Wall-clock duration of the parallel batch, in milliseconds. */
  duration_ms: number;
}
