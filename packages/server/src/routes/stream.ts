import { PassThrough } from "node:stream";
import type { FastifyInstance } from "fastify";

import type { TuttiRuntime } from "@tuttiai/core";
import type { TuttiEvent } from "@tuttiai/types";
import { estimateCostUsd } from "../cost.js";
import { scopeRunEvents } from "../run-scope.js";
import type { RunBody } from "./schemas.js";
import { conversationOf, runBodySchema } from "./schemas.js";

/**
 * Write a single SSE frame.
 *
 * Format: `data: { "event": "<name>", ...payload }\n\n`
 */
function sseWrite(
  stream: PassThrough,
  event: string,
  payload: Record<string, unknown>,
): void {
  stream.write(`data: ${JSON.stringify({ event, ...payload })}\n\n`);
}

/**
 * Maps internal {@link TuttiEvent} types to the SSE event names the
 * client sees. Events not in this map are silently dropped.
 */
function mapEvent(
  e: TuttiEvent,
): { name: string; payload: Record<string, unknown> } | undefined {
  switch (e.type) {
    case "turn:start":
      return { name: "turn_start", payload: { session_id: e.session_id, turn: e.turn } };
    case "tool:start":
      return { name: "tool_call", payload: { tool_name: e.tool_name, input: e.input } };
    case "tool:end":
      return { name: "tool_result", payload: { tool_name: e.tool_name, content: e.result.content, is_error: e.result.is_error } };
    case "token:stream":
      return { name: "content_delta", payload: { text: e.text } };
    case "turn:end":
      return { name: "turn_end", payload: { session_id: e.session_id, turn: e.turn } };
    case "interrupt:requested":
      return {
        name: "approval_requested",
        payload: {
          interrupt_id: e.interrupt_id,
          session_id: e.session_id,
          tool_name: e.tool_name,
          tool_args: e.tool_args,
        },
      };
    default:
      return undefined;
  }
}

/**
 * Write an SSE comment every `intervalMs` so an idle stream is not cut.
 * Clients ignore comment lines. A non-positive interval writes nothing.
 *
 * @returns Stops the heartbeat. Safe to call more than once.
 */
function startHeartbeat(stream: PassThrough, intervalMs: number): () => void {
  if (intervalMs <= 0) return () => undefined;
  const timer = setInterval(() => {
    if (!stream.destroyed && !stream.writableEnded) stream.write(": heartbeat\n\n");
  }, intervalMs);
  return () => clearInterval(timer);
}

/** Options for {@link registerStreamRoute}. */
export interface StreamRouteOptions {
  /** Agent key in the score. */
  readonly agent_name: string;
  /** Interval between `: heartbeat` comments. `0` turns them off. */
  readonly heartbeat_ms: number;
}

/**
 * Register `POST /run/stream` — execute an agent with Server-Sent Events.
 *
 * @remarks
 * `content_delta` events are only emitted when the agent is configured
 * with `streaming: true` in its score definition.
 *
 * Only events from the run this request starts are streamed. Concurrent
 * requests on the same runtime never see each other's frames.
 *
 * When a tool call needs a person's approval, the stream sends
 * `approval_requested` with `interrupt_id`, `session_id`, `tool_name` and
 * `tool_args`, then stays open while the run waits. Approving through
 * `POST /interrupts/:id/approve` resumes it on the same stream, so
 * `tool_result` and `run_complete` follow. Denying ends the run, and the
 * stream closes with an `error` frame carrying the denial.
 *
 * A client that disconnects before the run finishes aborts it: the run makes
 * no further model call, runs no further tool, and a pending approval is
 * withdrawn rather than left for a reviewer nobody is waiting on.
 *
 * A paused run writes nothing, and undici's `fetch` aborts a body after 300 s
 * without a chunk, so the route writes a `: heartbeat` SSE comment every
 * `heartbeat_ms` (15 s by default) for as long as the stream is open. SSE
 * clients discard comments.
 *
 * @param app     - Fastify instance.
 * @param runtime - Pre-built Tutti runtime.
 * @param options - The agent to run and the heartbeat interval.
 */
export function registerStreamRoute(
  app: FastifyInstance,
  runtime: TuttiRuntime,
  options: StreamRouteOptions,
): void {
  app.post<{ Body: RunBody }>("/run/stream", {
    schema: { body: runBodySchema },
  }, async (request, reply) => {
    const sse = new PassThrough();
    reply.type("text/event-stream").header("Cache-Control", "no-cache");
    reply.send(sse);
    const stopHeartbeat = startHeartbeat(sse, options.heartbeat_ms);

    // Scoped to this request's run: the event bus is shared by every
    // concurrent request, so an unscoped subscription streams other
    // clients' tokens and tool calls into this response.
    const scope = scopeRunEvents(runtime.events, (e: TuttiEvent) => {
      const mapped = mapEvent(e);
      if (mapped) sseWrite(sse, mapped.name, mapped.payload);
    });

    // Clean up if the client disconnects mid-stream. This listens on the
    // response, not the request: Node emits the request's `close` as soon as
    // its body has been read, which ended every stream before its first frame.
    // A response that closes after finishing is a normal end, not a departure.
    // A departed client also aborts the run, which otherwise carries on
    // calling tools, destructive ones included, for a caller that has gone.
    let clientClosed = false;
    const controller = new AbortController();
    reply.raw.on("close", () => {
      if (reply.raw.writableFinished) return;
      clientClosed = true;
      controller.abort("client disconnected");
      stopHeartbeat();
      scope.unsubscribe();
      if (!sse.destroyed) sse.end();
    });

    const start = Date.now();

    try {
      const result = await scope.run(() =>
        runtime.run(options.agent_name, request.body.input, request.body.session_id, {
          ...conversationOf(request.body),
          signal: controller.signal,
        }),
      );

      if (!clientClosed) {
        sseWrite(sse, "run_complete", {
          output: result.output,
          session_id: result.session_id,
          turns: result.turns,
          usage: result.usage,
          cost_usd: estimateCostUsd(result.usage),
          duration_ms: Date.now() - start,
        });
      }
    } catch (err: unknown) {
      if (!clientClosed) {
        const message = err instanceof Error ? err.message : "Internal server error";
        sseWrite(sse, "error", { message });
      }
    } finally {
      stopHeartbeat();
      scope.unsubscribe();
      if (!sse.destroyed) sse.end();
    }
  });
}
