/** Score — the top-level configuration file (tutti.score.ts). */

import type { AgentConfig } from "./agent.js";
import type { LLMProvider } from "./llm.js";
import type { TuttiHooks } from "./hooks.js";

export interface MemoryConfig {
  provider: "in-memory" | "postgres" | "redis";
  /**
   * Connection URL for database-backed providers. Ignored by `in-memory`.
   *
   * - `postgres` — a PostgreSQL connection string, e.g.
   *   `postgres://user:pass@host:5432/db` (commonly stored in
   *   `DATABASE_URL`).
   * - `redis` — a Redis connection URL, e.g.
   *   `redis://default:pass@host:6379/0` (commonly stored in `REDIS_URL`).
   *   Note: the Redis-backed session store is not yet implemented — the
   *   enum value is reserved.
   */
  url?: string;
}

export interface TelemetryConfig {
  enabled: boolean;
  /** OTLP HTTP endpoint (default: http://localhost:4318). */
  endpoint?: string;
  /** Extra headers sent with OTLP requests (e.g. auth tokens). */
  headers?: Record<string, string>;
  /**
   * Configures the `@tuttiai/telemetry` exporter pipeline, which forwards
   * in-process `TuttiSpan` events to OTLP-compatible backends. Independent
   * of the OpenTelemetry SDK setup gated by `enabled` above.
   */
  otlp?: {
    /** Full URL of the OTLP/HTTP traces endpoint (e.g. `http://localhost:4318/v1/traces`). */
    endpoint: string;
    /** Optional headers — vendor auth tokens, tenant ids, etc. */
    headers?: Record<string, string>;
  };
  /**
   * Append every closed span as newline-delimited JSON to this path.
   * Useful for offline analysis and CI eval artefacts.
   */
  jsonFile?: string;
  /**
   * Disable the `@tuttiai/telemetry` exporter pipeline entirely. Wins over
   * both score-file `otlp` / `jsonFile` settings and the `TUTTI_OTLP_ENDPOINT`
   * / `TUTTI_TRACE_FILE` environment variables.
   */
  disabled?: boolean;
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
