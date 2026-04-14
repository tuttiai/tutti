import type { FastifyInstance } from "fastify";

import type { GraphConfig } from "@tuttiai/core";
import { graphToJSON } from "@tuttiai/core";

/**
 * Register `GET /graph` — return the graph config as JSON.
 *
 * Condition functions are not serializable so they are stripped; edge
 * labels and structural information are preserved. Useful for external
 * visualization tools and the Tutti Studio frontend.
 *
 * @param app   - Fastify instance.
 * @param graph - Optional graph config. When absent the route returns 404.
 */
export function registerGraphRoute(
  app: FastifyInstance,
  graph?: GraphConfig,
): void {
  app.get("/graph", (_request, reply) => {
    if (!graph) {
      return reply.status(404).send({
        error: "No graph configured",
        message: "This server was started without a TuttiGraph. " +
          "Set ServerConfig.graph to enable this endpoint.",
      });
    }

    return reply.send(graphToJSON(graph));
  });
}
