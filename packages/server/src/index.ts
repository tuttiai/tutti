import Fastify, { type FastifyInstance } from "fastify";
import websocketPlugin from "@fastify/websocket";

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
import { registerTracesRoutes } from "./routes/traces.js";
import { registerInterruptsRoutes } from "./routes/interrupts.js";
import { registerStudioRoute } from "./routes/studio.js";
import { registerStudioEventsRoute } from "./routes/studio-events.js";
import {
  REALTIME_PUBLIC_PATHS,
  registerRealtimeRoutes,
} from "./routes/realtime.js";
import { SessionsRegistry } from "./sessions-registry.js";

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

  // 4. Auth — the `/studio` subtree (SPA assets + the SSE event stream)
  // is auth-bypassed whenever either the studio SPA or the live event
  // stream is mounted, so `EventSource` connections from the browser
  // (no Authorization header support) can still subscribe. The
  // `/realtime` and `/realtime-demo` paths are likewise exempt (the
  // realtime route does its own bearer check against `?api_key=`).
  const studioEnabled = config.studio_dist_dir !== undefined || config.graph_runner !== undefined;
  const realtimeEnabled = config.realtime === true;
  const publicPrefixes: string[] = [];
  if (studioEnabled) publicPrefixes.push("/studio");
  if (realtimeEnabled) publicPrefixes.push(...REALTIME_PUBLIC_PATHS);
  registerAuth(app, {
    api_key: resolveApiKey(config.api_key),
    ...(publicPrefixes.length > 0 ? { public_path_prefixes: publicPrefixes } : {}),
  });

  // 5. Global error handler
  registerErrorHandler(app);

  // Live directory of sessions seen during this server's lifetime.
  // Subscribed before any routes register so `/sessions` reflects every
  // run that happens after server boot.
  const sessions = new SessionsRegistry(config.runtime);
  // eslint-disable-next-line @typescript-eslint/require-await -- Fastify hooks must be async, but `close` is synchronous.
  app.addHook("onClose", async () => {
    sessions.close();
  });

  // 6. Routes
  registerHealthRoute(app);
  registerRunRoute(app, config.runtime, config.agent_name, timeoutMs, config.graph_runner);
  registerStreamRoute(app, config.runtime, config.agent_name);
  registerSessionsRoute(
    app,
    config.runtime,
    sessions,
    config.agent_name,
    config.graph_runner,
  );
  registerGraphRoute(app, config.graph_runner?.config ?? config.graph);
  registerTracesRoutes(app);
  registerInterruptsRoutes(app, config.runtime);
  if (config.studio_dist_dir) {
    registerStudioRoute(app, config.studio_dist_dir);
  }
  registerStudioEventsRoute(app, config.graph_runner);

  if (realtimeEnabled) {
    if (!config.score) {
      throw new Error(
        "createServer: `realtime: true` requires a `score` so the realtime route can read each agent's `realtime` config.",
      );
    }
    await app.register(websocketPlugin);
    registerRealtimeRoutes(app, {
      runtime: config.runtime,
      score: config.score,
      agentName: config.agent_name,
      apiKey: resolveApiKey(config.api_key),
    });
  }

  return app;
}
