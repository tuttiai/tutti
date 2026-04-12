/** Agent configuration and result types. */

import type { ChatMessage, TokenUsage } from "./llm.js";
import type { Permission } from "./voice.js";
import type { Voice } from "./voice.js";

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
  /** Agent IDs this agent can delegate to via the orchestrator. */
  delegates?: string[];
  /** Role in the orchestration — orchestrator receives input first. */
  role?: "orchestrator" | "specialist";
}

export interface AgentResult {
  session_id: string;
  output: string;
  messages: ChatMessage[];
  turns: number;
  usage: TokenUsage;
}
