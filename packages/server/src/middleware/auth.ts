import type {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
} from "fastify";

import { SecretsManager } from "@tuttiai/core";

/** Options for {@link registerAuth}. */
export interface AuthOptions {
  /**
   * Shared secret clients must present in `Authorization: Bearer <key>`.
   *
   * When `undefined` the middleware rejects every request with 401 so that
   * a misconfigured server cannot be exploited by omitting credentials.
   */
  api_key: string | undefined;
  /**
   * Paths that skip authentication. Typically only `/health`.
   *
   * Compared by exact match against `request.url` minus any query string.
   */
  public_paths?: readonly string[];
}

const DEFAULT_PUBLIC_PATHS = ["/health"] as const;

/**
 * Resolve the effective API key: explicit config wins, otherwise the
 * `TUTTI_API_KEY` environment variable. Returns `undefined` when neither
 * is set.
 */
export function resolveApiKey(configured: string | undefined): string | undefined {
  if (configured !== undefined && configured !== "") return configured;
  return SecretsManager.optional("TUTTI_API_KEY");
}

/**
 * Extract the bearer token from an `Authorization` header value.
 *
 * Returns `undefined` if the header is missing, malformed, or uses a
 * scheme other than `Bearer` (case-insensitive).
 */
export function extractBearer(header: string | undefined): string | undefined {
  if (typeof header !== "string") return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match?.[1];
}

/**
 * Constant-time string comparison to avoid leaking the API key via
 * timing side channels.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function stripQuery(url: string): string {
  const q = url.indexOf("?");
  return q === -1 ? url : url.slice(0, q);
}

/**
 * Register the bearer-token auth hook on a Fastify instance.
 *
 * @param app - The Fastify instance to attach the hook to.
 * @param options - Auth options; see {@link AuthOptions}.
 */
export function registerAuth(app: FastifyInstance, options: AuthOptions): void {
  const expected = options.api_key;
  const publicPaths = new Set(options.public_paths ?? DEFAULT_PUBLIC_PATHS);

  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    if (publicPaths.has(stripQuery(request.url))) return;

    if (expected === undefined) {
      await reply.code(401).send({ error: "server_not_configured" });
      return;
    }

    const header = request.headers["authorization"];
    const token = extractBearer(typeof header === "string" ? header : undefined);

    if (token === undefined || !timingSafeEqual(token, expected)) {
      await reply.code(401).send({ error: "unauthorized" });
      return;
    }
  });
}

/**
 * Fastify plugin form of the auth middleware. Useful when composing
 * multiple plugins via `app.register`.
 */
export const authPlugin: FastifyPluginAsync<AuthOptions> = async (app, options) => {
  registerAuth(app, options);
};
