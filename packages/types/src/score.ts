/** Score — the top-level configuration file (tutti.score.ts). */

import type { AgentConfig } from "./agent.js";
import type { LLMProvider } from "./llm.js";

export interface ScoreConfig {
  name: string;
  description?: string;
  agents: Record<string, AgentConfig>;
  provider: LLMProvider;
  default_model?: string;
}
