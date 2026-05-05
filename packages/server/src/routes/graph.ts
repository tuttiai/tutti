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
 * When no graph is configured the route returns an empty graph
 * (`{ nodes: [], edges: [] }`) rather than 404, so polling frontends
 * (e.g. the studio canvas) can render an empty state without
 * special-casing the absence of a graph.
 *
 * @param app   - Fastify instance.
 * @param graph - Optional graph config.
 */
export function registerGraphRoute(
  app: FastifyInstance,
  graph?: GraphConfig,
): void {
  app.get("/graph", (_request, reply) => {
    if (!graph) {
      return reply.send({ nodes: [], edges: [] });
    }
    return reply.send(graphToJSON(graph));
  });
}
