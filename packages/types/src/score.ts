/** Score — the top-level configuration file (tutti.score.ts). */

import type { AgentConfig } from "./agent.js";
import type { LLMProvider } from "./llm.js";
import type { TuttiHooks } from "./hooks.js";

export interface MemoryConfig {
  provider: "in-memory" | "postgres" | "redis";
  /** Connection URL (e.g. DATABASE_URL for postgres). */
  url?: string;
}

export interface TelemetryConfig {
  enabled: boolean;
  /** OTLP HTTP endpoint (default: http://localhost:4318). */
  endpoint?: string;
  /** Extra headers sent with OTLP requests (e.g. auth tokens). */
  headers?: Record<string, string>;
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
  /** OpenTelemetry tracing configuration. */
  telemetry?: TelemetryConfig;
  /** Global lifecycle hooks — apply to all agents. */
  hooks?: TuttiHooks;
}
