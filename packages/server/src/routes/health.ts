import type { FastifyInstance } from "fastify";

import { SERVER_VERSION } from "../config.js";

const startedAt = Date.now();

/**
 * Register the `/health` liveness endpoint.
 *
 * Returns server status, package version, and process uptime.
 * This route is on the public-paths allowlist so it never requires auth.
 */
export function registerHealthRoute(app: FastifyInstance): void {
  app.get("/health", () => ({
    status: "ok",
    version: SERVER_VERSION,
    uptime_s: Math.floor((Date.now() - startedAt) / 1000),
  }));
}
