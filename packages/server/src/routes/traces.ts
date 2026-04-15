import { PassThrough } from "node:stream";
import type { FastifyInstance } from "fastify";

import {
  buildTraceSummaries,
  getTuttiTracer,
  type TuttiSpan,
} from "@tuttiai/core";

const DEFAULT_LIST_LIMIT = 20;

/**
 * Serialise a {@link TuttiSpan} for the wire. `started_at` and `ended_at`
 * are converted to ISO strings so JSON.stringify produces a stable shape
 * (otherwise `Date` round-trips as a tagged value the SSE client would
 * have to parse).
 */
function spanToJson(span: TuttiSpan): Record<string, unknown> {
  return {
    span_id: span.span_id,
    trace_id: span.trace_id,
    ...(span.parent_span_id !== undefined ? { parent_span_id: span.parent_span_id } : {}),
    name: span.name,
    kind: span.kind,
    started_at: span.started_at.toISOString(),
    ...(span.ended_at !== undefined ? { ended_at: span.ended_at.toISOString() } : {}),
    ...(span.duration_ms !== undefined ? { duration_ms: span.duration_ms } : {}),
    status: span.status,
    attributes: span.attributes,
    ...(span.error !== undefined ? { error: span.error } : {}),
  };
}

/**
 * Register the `/traces` route family — list, show, and live tail of the
 * in-process {@link getTuttiTracer} singleton.
 *
 * - `GET /traces` — last 20 trace summaries, most recent first.
 * - `GET /traces/:id` — every span belonging to one trace.
 * - `GET /traces/stream` — Server-Sent Events; one frame per span on
 *   open and close.
 */
export function registerTracesRoutes(app: FastifyInstance): void {
  app.get("/traces", () => {
    const tracer = getTuttiTracer();
    const traces = buildTraceSummaries(tracer.getAllSpans(), DEFAULT_LIST_LIMIT);
    return { traces };
  });

  app.get<{ Params: { id: string } }>("/traces/:id", (request, reply) => {
    const tracer = getTuttiTracer();
    const spans = tracer.getTrace(request.params.id);
    if (spans.length === 0) {
      return reply.code(404).send({
        error: "trace_not_found",
        message: `No trace with id "${request.params.id}"`,
      });
    }
    return reply.code(200).send({
      trace_id: request.params.id,
      spans: spans.map(spanToJson),
    });
  });

  app.get("/traces/stream", (request, reply) => {
    const tracer = getTuttiTracer();
    const sse = new PassThrough();
    reply.type("text/event-stream").header("Cache-Control", "no-cache");
    reply.send(sse);

    const unsubscribe = tracer.subscribe((span) => {
      // Tracer fires once on open and once on close. Forward both — the
      // CLI's tail mode renders each event as it arrives so users see
      // the open->close transition (status flips from running to ok/error).
      if (sse.destroyed) return;
      sse.write(`data: ${JSON.stringify(spanToJson(span))}\n\n`);
    });

    request.raw.on("close", () => {
      unsubscribe();
      if (!sse.destroyed) sse.end();
    });
  });
}
