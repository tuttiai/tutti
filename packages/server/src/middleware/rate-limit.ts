import type { FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";

import type { RateLimitConfig } from "../config.js";
import { extractBearer } from "./auth.js";

/** Default rate-limit: 60 requests per minute per API key. */
const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  max: 60,
  timeWindow: "1 minute",
};

/**
 * Register the `@fastify/rate-limit` plugin.
 *
 * Requests are bucketed by API key (from the `Authorization` header).
 * When the limit is exceeded the client receives a 429 with
 * `{ error: "rate_limit_exceeded", retry_after_ms }`.
 *
 * @param app    - Fastify instance.
 * @param config - Caller-supplied limit, or `undefined` to use defaults.
 */
export async function registerRateLimit(
  app: FastifyInstance,
  config: RateLimitConfig | undefined,
): Promise<void> {
  const { max, timeWindow } = config ?? DEFAULT_RATE_LIMIT;

  await app.register(rateLimit, {
    max,
    timeWindow,
    keyGenerator: (request) => {
      const token = extractBearer(
        typeof request.headers["authorization"] === "string"
          ? request.headers["authorization"]
          : undefined,
      );
      return token ?? request.ip;
    },
    // Don't rate-limit the health endpoint.
    allowList: (request) => request.url === "/health",
  });
}
