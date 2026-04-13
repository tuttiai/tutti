/** Agent configuration and result types. */

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
}

export interface AgentResult {
  session_id: string;
  output: string;
  messages: ChatMessage[];
  turns: number;
  usage: TokenUsage;
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
