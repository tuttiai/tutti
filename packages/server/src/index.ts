import Fastify, { type FastifyInstance } from "fastify";

import { DEFAULT_TIMEOUT_MS } from "./config.js";
import { registerRequestId } from "./middleware/request-id.js";
import { registerCors } from "./middleware/cors.js";
import { registerRateLimit } from "./middleware/rate-limit.js";
import { registerAuth, resolveApiKey } from "./middleware/auth.js";
import { registerErrorHandler } from "./middleware/errors.js";
import { registerHealthRoute } from "./routes/health.js";
import { registerRunRoute } from "./routes/run.js";
import { registerStreamRoute } from "./routes/stream.js";
import { registerSessionsRoute } from "./routes/sessions.js";
import { registerGraphRoute } from "./routes/graph.js";

export {
  DEFAULT_HOST,
  DEFAULT_PORT,
  DEFAULT_TIMEOUT_MS,
  SERVER_VERSION,
  type RateLimitConfig,
  type ServerConfig,
} from "./config.js";
export { registerAuth, resolveApiKey, extractBearer } from "./middleware/auth.js";
export type { AuthOptions } from "./middleware/auth.js";
export { estimateCostUsd } from "./cost.js";

import type { ServerConfig } from "./config.js";

/**
 * Build (but do not start) the Tutti HTTP server.
 *
 * Middleware is registered in order:
 *  1. Request ID — attaches `x-request-id` to every response.
 *  2. CORS — resolves from config / `TUTTI_ALLOWED_ORIGINS` / `"*"`.
 *  3. Rate limit — 60 req/min per API key by default.
 *  4. Bearer auth — fail-closed API key verification.
 *  5. Global error handler — maps TuttiError subtypes to HTTP status codes.
 *  6. Routes — /health, /run, /run/stream, /sessions/:id.
 *
 * @param config - Runtime server configuration. See {@link ServerConfig}.
 * @returns A configured {@link FastifyInstance}. Call `.listen()` to bind
 *          a socket, or `.inject()` to exercise routes in tests.
 */
export async function createServer(config: ServerConfig): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    disableRequestLogging: true,
    trustProxy: false,
  });

  const timeoutMs = config.timeout_ms ?? DEFAULT_TIMEOUT_MS;

  // 1. Request ID
  registerRequestId(app);

  // 2. CORS (plugin — must be awaited)
  await registerCors(app, config.cors_origins);

  // 3. Rate limit (plugin — must be awaited; false disables)
  if (config.rate_limit !== false) {
    const rl = config.rate_limit === undefined ? undefined : config.rate_limit;
    await registerRateLimit(app, rl);
  }

  // 4. Auth
  registerAuth(app, { api_key: resolveApiKey(config.api_key) });

  // 5. Global error handler
  registerErrorHandler(app);

  // 6. Routes
  registerHealthRoute(app);
  registerRunRoute(app, config.runtime, config.agent_name, timeoutMs);
  registerStreamRoute(app, config.runtime, config.agent_name);
  registerSessionsRoute(app, config.runtime);
  registerGraphRoute(app, config.graph);

  return app;
}
