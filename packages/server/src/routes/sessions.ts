import type { FastifyInstance } from "fastify";

import type { TuttiRuntime } from "@tuttiai/core";

/**
 * Register `GET /sessions/:id` — retrieve a session's conversation history.
 *
 * @param app     - Fastify instance.
 * @param runtime - Pre-built Tutti runtime.
 */
export function registerSessionsRoute(
  app: FastifyInstance,
  runtime: TuttiRuntime,
): void {
  app.get<{ Params: { id: string } }>("/sessions/:id", async (request, reply) => {
    const session = runtime.getSession(request.params.id);

    if (!session) {
      return reply.code(404).send({
        error: "session_not_found",
        message: `No session with id "${request.params.id}"`,
      });
    }

    return reply.code(200).send({
      session_id: session.id,
      turns: session.messages,
      created_at: session.created_at.toISOString(),
      updated_at: session.updated_at.toISOString(),
    });
  });
}
