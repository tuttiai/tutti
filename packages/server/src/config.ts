import type { AgentConfig } from "@tuttiai/types";

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
 * `SecretsManager.optional`). If neither is set the server starts in
 * unauthenticated mode and the auth middleware rejects every request so
 * that an accidentally-exposed server cannot be used.
 */
export interface ServerConfig {
  /** Port the server listens on. Defaults to {@link DEFAULT_PORT}. */
  port: number;
  /** Interface the server binds to. Defaults to {@link DEFAULT_HOST}. */
  host: string;
  /**
   * Shared secret clients must present in `Authorization: Bearer <key>`.
   * When omitted it falls back to `process.env.TUTTI_API_KEY`.
   */
  api_key?: string;
  /** Optional rate-limit policy applied to all routes. */
  rate_limit?: RateLimitConfig;
  /** Agent configuration used by route handlers to run agents. */
  agent_config: AgentConfig;
}
