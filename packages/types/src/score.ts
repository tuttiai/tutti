/** Score — the top-level configuration file (tutti.score.ts). */

import type { AgentConfig } from "./agent.js";
import type { LLMProvider } from "./llm.js";

export interface MemoryConfig {
  provider: "in-memory" | "postgres" | "redis";
  /** Connection URL (e.g. DATABASE_URL for postgres). */
  url?: string;
}

export interface ScoreConfig {
  name?: string;
  description?: string;
  agents: Record<string, AgentConfig>;
  provider: LLMProvider;
  default_model?: string;
  /** Which agent is the entry point (default: "orchestrator"). */
  entry?: string;
  /** Session storage configuration (default: in-memory). */
  memory?: MemoryConfig;
}
