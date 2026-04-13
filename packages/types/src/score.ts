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

/**
 * Declarative parallel entry — when set as `ScoreConfig.entry`, calling
 * `AgentRouter.run(input)` fans the input out to every listed agent
 * simultaneously instead of routing through a single orchestrator.
 */
export interface ParallelEntryConfig {
  type: "parallel";
  /** Agent IDs to run simultaneously. Must all exist in `agents`. */
  agents: string[];
}

export interface ScoreConfig {
  name?: string;
  description?: string;
  agents: Record<string, AgentConfig>;
  provider: LLMProvider;
  default_model?: string;
  /**
   * Entry point for `AgentRouter.run()`. Either the ID of a single
   * orchestrator agent (default: `"orchestrator"`), or a `ParallelEntryConfig`
   * that fans the input out to several agents simultaneously.
   */
  entry?: string | ParallelEntryConfig;
  /** Session storage configuration (default: in-memory). */
  memory?: MemoryConfig;
  /** OpenTelemetry tracing configuration. */
  telemetry?: TelemetryConfig;
  /** Global lifecycle hooks — apply to all agents. */
  hooks?: TuttiHooks;
}
