import Fastify, { type FastifyInstance } from "fastify";

import { registerAuth, resolveApiKey } from "./middleware/auth.js";
import { registerHealthRoute } from "./routes/health.js";

export {
  DEFAULT_HOST,
  DEFAULT_PORT,
  type RateLimitConfig,
  type ServerConfig,
} from "./config.js";
export { registerAuth, resolveApiKey, extractBearer } from "./middleware/auth.js";
export type { AuthOptions } from "./middleware/auth.js";

import type { ServerConfig } from "./config.js";

/**
 * Build (but do not start) the Tutti HTTP server.
 *
 * @param config - Runtime server configuration. See {@link ServerConfig}.
 * @returns A configured {@link FastifyInstance}. Call `.listen()` to bind
 *          a socket, or `.inject()` to exercise routes in tests.
 *
 * @example
 * const app = createServer({
 *   port: 3847,
 *   host: "127.0.0.1",
 *   agent_config: myAgent,
 * });
 * await app.listen({ port: 3847, host: "127.0.0.1" });
 */
export function createServer(config: ServerConfig): FastifyInstance {
  const app = Fastify({
    logger: false,
    disableRequestLogging: true,
    trustProxy: false,
  });

  registerAuth(app, { api_key: resolveApiKey(config.api_key) });
  registerHealthRoute(app);

  return app;
}
