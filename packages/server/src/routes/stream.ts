import { PassThrough } from "node:stream";
import type { FastifyInstance } from "fastify";

import type { TuttiRuntime } from "@tuttiai/core";
import type { TuttiEvent } from "@tuttiai/types";
import { estimateCostUsd } from "../cost.js";
import type { RunBody } from "./schemas.js";
import { runBodySchema } from "./schemas.js";

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
    default:
      return undefined;
  }
}

/**
 * Register `POST /run/stream` — execute an agent with Server-Sent Events.
 *
 * @remarks
 * `content_delta` events are only emitted when the agent is configured
 * with `streaming: true` in its score definition.
 *
 * @param app       - Fastify instance.
 * @param runtime   - Pre-built Tutti runtime.
 * @param agentName - Agent key in the score.
 */
export function registerStreamRoute(
  app: FastifyInstance,
  runtime: TuttiRuntime,
  agentName: string,
): void {
  app.post<{ Body: RunBody }>("/run/stream", {
    schema: { body: runBodySchema },
  }, async (request, reply) => {
    const sse = new PassThrough();
    reply.type("text/event-stream").header("Cache-Control", "no-cache");
    reply.send(sse);

    const unsubs: (() => void)[] = [];

    const unsubAll = runtime.events.onAny((e: TuttiEvent) => {
      const mapped = mapEvent(e);
      if (mapped) sseWrite(sse, mapped.name, mapped.payload);
    });
    unsubs.push(unsubAll);

    // Clean up if the client disconnects mid-stream.
    let clientClosed = false;
    request.raw.on("close", () => {
      clientClosed = true;
      for (const u of unsubs) u();
      if (!sse.destroyed) sse.end();
    });

    const start = Date.now();

    try {
      const result = await runtime.run(
        agentName,
        request.body.input,
        request.body.session_id,
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
      for (const u of unsubs) u();
      if (!sse.destroyed) sse.end();
    }
  });
}
