import type { FastifyInstance } from "fastify";
import cors from "@fastify/cors";

import { SecretsManager } from "@tuttiai/core";

/**
 * Resolve the CORS origin list.
 *
 * Priority: explicit `configured` arg → `TUTTI_ALLOWED_ORIGINS` env var
 * (comma-separated) → `"*"` (open).
 */
export function resolveOrigins(
  configured: string | readonly string[] | undefined,
): string | string[] {
  if (typeof configured === "string") return configured;
  if (Array.isArray(configured)) return Array.from(configured) as string[];

  const env = SecretsManager.optional("TUTTI_ALLOWED_ORIGINS");
  if (env) {
    return env.split(",").map((o) => o.trim()).filter(Boolean);
  }

  return "*";
}

/**
 * Register `@fastify/cors` with the resolved origin list.
 *
 * Allowed headers: `Authorization`, `Content-Type`.
 *
 * @param app     - Fastify instance.
 * @param origins - Explicit origin(s), or `undefined` to fall back to
 *                  `TUTTI_ALLOWED_ORIGINS` / `"*"`.
 */
export async function registerCors(
  app: FastifyInstance,
  origins: string | readonly string[] | undefined,
): Promise<void> {
  const resolved = resolveOrigins(origins);

  await app.register(cors, {
    origin: resolved,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type"],
    credentials: resolved !== "*",
  });
}
