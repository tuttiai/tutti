import { PassThrough } from "node:stream";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { GraphEvent, TuttiGraph } from "@tuttiai/core";

/**
 * Wire-format event sent over `GET /studio/events`. Snake_case fields
 * mirror the convention used by `POST /run/stream` so frontends only
 * need one shape to learn.
 */
type StudioWireEvent =
  | {
      type: "node:start";
      node_id: string;
      session_id: string | null;
      timestamp: number;
    }
  | {
      type: "node:complete";
      node_id: string;
      session_id: string | null;
      output: string;
      duration_ms: number;
    }
  | {
      type: "node:error";
      node_id: string;
      session_id: string | null;
      error: string;
      duration_ms: number;
    }
  | { type: "run:start"; session_id: string | null }
  | { type: "run:complete"; session_id: string | null; path: string[] };

/**
 * Translate an internal {@link GraphEvent} to the studio wire shape.
 *
 * Internal naming (`graph:start` / `node:end`) is mapped to the studio's
 * `run:*` / `node:complete` vocabulary so the frontend reads cleanly.
 * Events outside the studio's vocabulary (state:update, edge:evaluate,
 * node:skip, …) are dropped — they're internal-only.
 */
function toWire(e: GraphEvent): StudioWireEvent | undefined {
  const sessionId = e.session_id ?? null;

  switch (e.type) {
    case "graph:start":
      return { type: "run:start", session_id: sessionId };
    case "graph:end":
      return {
        type: "run:complete",
        session_id: sessionId,
        path: e.result.path,
      };
    case "node:start":
      return {
        type: "node:start",
        node_id: e.node_id,
        session_id: sessionId,
        timestamp: Date.now(),
      };
    case "node:end":
      return {
        type: "node:complete",
        node_id: e.node_id,
        session_id: sessionId,
        output: e.result.output,
        duration_ms: e.duration_ms,
      };
    case "node:error":
      return {
        type: "node:error",
        node_id: e.node_id,
        session_id: sessionId,
        error: e.error,
        duration_ms: e.duration_ms,
      };
    default:
      return undefined;
  }
}

function sseFrame(payload: StudioWireEvent): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/**
 * Register `GET /studio/events` — Server-Sent Events stream of
 * graph execution events for the studio canvas.
 *
 * The stream is open for the lifetime of the request. Every connected
 * client gets every event from every run on the configured graph. Each
 * event carries `session_id` so clients can filter or correlate.
 *
 * A heartbeat comment frame is sent every 25 s to keep proxies and
 * browsers from idling the connection out.
 *
 * @param app   - Fastify instance.
 * @param graph - The {@link TuttiGraph} whose events to stream. When
 *                absent the route returns 404.
 */
export function registerStudioEventsRoute(
  app: FastifyInstance,
  graph: TuttiGraph | undefined,
): void {
  app.get(
    "/studio/events",
    async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      if (!graph) {
        await reply.code(404).send({
          error: "studio_events_unavailable",
          message:
            "GET /studio/events requires a graph to be configured. " +
            "Start the server with `tutti-ai serve --studio` and a score that exports `graph`.",
        });
        return;
      }

      const stream = new PassThrough();

      reply.raw.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });

      // Initial comment frame — flushes the headers right away so EventSource
      // moves to OPEN even before any real event has fired.
      stream.write(": connected\n\n");

      const heartbeat = setInterval(() => {
        stream.write(": ping\n\n");
      }, 25_000);

      const unsubscribe = graph.subscribe((e) => {
        const wire = toWire(e);
        if (wire) stream.write(sseFrame(wire));
      });

      const close = (): void => {
        clearInterval(heartbeat);
        unsubscribe();
        stream.end();
      };

      request.raw.once("close", close);
      reply.raw.once("close", close);

      stream.pipe(reply.raw);
    },
  );
}
