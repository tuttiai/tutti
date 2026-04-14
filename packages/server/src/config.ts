import type { TuttiRuntime } from "@tuttiai/core";

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
export const SERVER_VERSION = "0.1.0";

/**
 * Optional per-window rate limit configuration applied to all routes.
 *
 * @remarks
 * The server itself only exposes this shape; enforcement lives in the
 * rate-limit middleware.
 */
export interface RateLimitConfig {
  /** Maximum number of requests allowed in a single window. */
  max: number;
  /** Window length in milliseconds. */
  window_ms: number;
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
  /** Optional rate-limit policy applied to all routes. */
  rate_limit?: RateLimitConfig;
  /** Pre-built runtime that owns the provider, event bus, and sessions. */
  runtime: TuttiRuntime;
  /** Agent key in the score's `agents` map to expose over HTTP. */
  agent_name: string;
  /** Non-streaming request timeout in ms. Defaults to {@link DEFAULT_TIMEOUT_MS}. */
  timeout_ms?: number;
}
