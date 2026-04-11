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

export interface AgentConfig {
  name: string;
  description?: string;
  model?: string;
  system_prompt: string;
  voices: Voice[];
  permissions?: Permission[];
  max_turns?: number;
  max_tool_calls?: number;
  budget?: BudgetConfig;
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
