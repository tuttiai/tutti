/** Agent configuration and result types. */

import type { ChatMessage, TokenUsage } from "./llm.js";
import type { Permission } from "./voice.js";
import type { Voice } from "./voice.js";

export interface AgentConfig {
  name: string;
  description?: string;
  model?: string;
  system_prompt: string;
  voices: Voice[];
  permissions?: Permission[];
  max_turns?: number;
  max_tool_calls?: number;
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
