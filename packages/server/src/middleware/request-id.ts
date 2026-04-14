import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

/**
 * Attach a unique request ID to every response via `x-request-id`.
 *
 * If the client sends an `x-request-id` header it is reused; otherwise a
 * random UUID v4 is generated. The ID is also set on `request.id` so
 * downstream handlers and the error handler can reference it.
 */
export function registerRequestId(app: FastifyInstance): void {
  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    const header = request.headers["x-request-id"];
    const id = typeof header === "string" && header.length > 0
      ? header
      : randomUUID();

    // Fastify exposes request.id as readonly; we override via the raw
    // property so that the error handler and logger can read it.
    (request as { id: string }).id = id;

    // Do NOT await reply.header() — FastifyReply is thenable in v5 and
    // awaiting it blocks inject() indefinitely.
    reply.header("x-request-id", id);
  });
}
