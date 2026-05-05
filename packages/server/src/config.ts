import type { TuttiRuntime, GraphConfig, TuttiGraph } from "@tuttiai/core";

/**
 * Default HTTP port for the Tutti server.
 *
 * Chosen to avoid conflicts with common local dev ports (3000, 4000, 8080)
 * and with the Tutti Studio port (4747).
 */
export const DEFAULT_PORT = 3847;

/**
 * Default bind host. Loopback-only by default so the server is never
 * accidentally exposed on a public interface.
 */
export const DEFAULT_HOST = "127.0.0.1";

/** Default request timeout in milliseconds for non-streaming runs. */
export const DEFAULT_TIMEOUT_MS = 120_000;

/** Package version, surfaced via the `/health` endpoint. */
export const SERVER_VERSION = "0.1.1";

/**
 * Rate-limit policy applied to authenticated routes.
 *
 * @remarks
 * Backed by `@fastify/rate-limit`. The `timeWindow` value is passed
 * directly to the plugin and accepts human-readable strings like
 * `"1 minute"` or `"30 seconds"`.
 */
export interface RateLimitConfig {
  /** Maximum requests allowed within a single window. */
  max: number;
  /** Window duration — e.g. `"1 minute"`, `"30 seconds"`. */
  timeWindow: string;
}

/**
 * Configuration for {@link createServer}.
 *
 * @remarks
 * `api_key` is resolved at server construction time: when omitted the value
 * of the `TUTTI_API_KEY` environment variable is used instead (via
 * `SecretsManager.optional`). If neither is set the auth middleware rejects
 * every non-public request (fail-closed).
 */
export interface ServerConfig {
  /** Port the server listens on. Defaults to {@link DEFAULT_PORT}. */
  port: number;
  /** Interface the server binds to. Defaults to {@link DEFAULT_HOST}. */
  host: string;
  /**
   * Shared secret clients must present in `Authorization: Bearer <key>`.
   * Falls back to `TUTTI_API_KEY` env var when omitted.
   */
  api_key?: string;
  /**
   * Rate-limit policy. Defaults to 60 req/min per API key.
   * Pass `false` to disable entirely.
   */
  rate_limit?: RateLimitConfig | false;
  /**
   * Allowed CORS origins. Falls back to the `TUTTI_ALLOWED_ORIGINS` env
   * var (comma-separated), then `"*"` (open) if neither is set.
   */
  cors_origins?: string | readonly string[];
  /** Pre-built runtime that owns the provider, event bus, and sessions. */
  runtime: TuttiRuntime;
  /** Agent key in the score's `agents` map to expose over HTTP. */
  agent_name: string;
  /** Non-streaming request timeout in ms. Defaults to {@link DEFAULT_TIMEOUT_MS}. */
  timeout_ms?: number;
  /** Optional graph config — when provided, `GET /graph` returns its JSON representation. */
  graph?: GraphConfig;
  /**
   * Live {@link TuttiGraph} instance that powers `POST /run` and the
   * `GET /studio/events` SSE stream when set.
   *
   * - `POST /run` delegates to `graph_runner.run(input, { session_id })`
   *   instead of `runtime.run(agent, ...)` so the entrypoint is the
   *   graph, not a single agent.
   * - `GET /studio/events` subscribes to `graph_runner.subscribe(...)`
   *   and writes execution events to every connected client.
   *
   * The runner shares an `AgentRunner` with `runtime` (built via
   * `runtime.createGraph(config)`) so the existing `runtime.events`
   * bus also receives `agent:start`, `tool:start`, etc.
   */
  graph_runner?: TuttiGraph;
  /**
   * Mount the Tutti Studio SPA at `/studio/*`. Pass an absolute path to
   * the built `dist/` directory of `@tuttiai/studio` (the CLI resolves
   * this for you when `tutti-ai serve --studio` is used).
   *
   * The entire `/studio` subtree is exempt from bearer auth.
   */
  studio_dist_dir?: string;
}
