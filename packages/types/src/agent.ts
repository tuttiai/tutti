/** Agent configuration and result types. */

import type { ChatMessage, TokenUsage } from "./llm.js";
import type { Voice } from "./voice.js";

export interface AgentConfig {
  name: string;
  description?: string;
  model?: string;
  system_prompt: string;
  voices: Voice[];
  max_turns?: number;
}

export interface AgentResult {
  session_id: string;
  output: string;
  messages: ChatMessage[];
  turns: number;
  usage: TokenUsage;
}
