import Fastify, { type FastifyInstance } from "fastify";

import { DEFAULT_TIMEOUT_MS } from "./config.js";
import { registerAuth, resolveApiKey } from "./middleware/auth.js";
import { registerHealthRoute } from "./routes/health.js";
import { registerRunRoute } from "./routes/run.js";
import { registerStreamRoute } from "./routes/stream.js";
import { registerSessionsRoute } from "./routes/sessions.js";

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
 * @param config - Runtime server configuration. See {@link ServerConfig}.
 * @returns A configured {@link FastifyInstance}. Call `.listen()` to bind
 *          a socket, or `.inject()` to exercise routes in tests.
 *
 * @example
 * ```ts
 * const runtime = new TuttiRuntime(score);
 * const app = createServer({
 *   port: 3847,
 *   host: "127.0.0.1",
 *   runtime,
 *   agent_name: "assistant",
 * });
 * await app.listen({ port: 3847, host: "127.0.0.1" });
 * ```
 */
export function createServer(config: ServerConfig): FastifyInstance {
  const app = Fastify({
    logger: false,
    disableRequestLogging: true,
    trustProxy: false,
  });

  const timeoutMs = config.timeout_ms ?? DEFAULT_TIMEOUT_MS;

  registerAuth(app, { api_key: resolveApiKey(config.api_key) });
  registerHealthRoute(app);
  registerRunRoute(app, config.runtime, config.agent_name, timeoutMs);
  registerStreamRoute(app, config.runtime, config.agent_name);
  registerSessionsRoute(app, config.runtime);

  return app;
}
