import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";

import type { TuttiGraph, TuttiRuntime } from "@tuttiai/core";
import { estimateCostUsd } from "../cost.js";
import { DEFAULT_TIMEOUT_MS } from "../config.js";
import { scopeRunEvents } from "../run-scope.js";
import type { RunBody } from "./schemas.js";
import { conversationOf, runBodySchema } from "./schemas.js";

/**
 * Register `POST /run` — execute the configured entrypoint to completion.
 *
 * When `graph` is supplied the request runs through the {@link TuttiGraph}
 * (so studio listeners receive `node:start` / `node:end` / etc.).
 * Otherwise the request runs the named agent through the runtime.
 *
 * The response shape is intentionally identical for both modes
 * (`output`, `session_id`, `duration_ms`) so existing API consumers
 * don't need to change when a graph is added.
 *
 * @param app       - Fastify instance.
 * @param runtime   - Pre-built Tutti runtime.
 * @param agentName - Agent key in the score (used only when `graph` is unset).
 * @param timeoutMs - Max wall-clock time before returning 504.
 * @param graph     - Optional graph. When set, takes precedence over `agentName`.
 */
export function registerRunRoute(
  app: FastifyInstance,
  runtime: TuttiRuntime,
  agentName: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  graph?: TuttiGraph,
): void {
  app.post<{ Body: RunBody }>("/run", {
    schema: { body: runBodySchema },
  }, async (request, reply) => {
    // Scoped to this request's run so a 504's partial_output never
    // carries tokens streamed by a concurrent request.
    let partialOutput = "";
    const scope = scopeRunEvents(runtime.events, (e) => {
      if (e.type === "token:stream") partialOutput += e.text;
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const start = Date.now();

    try {
      const result = await Promise.race([
        scope.run(() =>
          runEntry(runtime, graph, agentName, request.body),
        ),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("TIMEOUT")), timeoutMs);
        }),
      ]);

      if (timer) clearTimeout(timer);
      scope.unsubscribe();

      return reply.code(200).send({
        output: result.output,
        session_id: result.session_id,
        turns: result.turns,
        usage: result.usage,
        cost_usd: estimateCostUsd(result.usage),
        duration_ms: Date.now() - start,
      });
    } catch (err: unknown) {
      if (timer) clearTimeout(timer);
      scope.unsubscribe();

      // Route-local timeout handling — not a TuttiError, so we handle it
      // here rather than letting the global error handler map it.
      const isTimeout = err instanceof Error && err.message === "TIMEOUT";
      if (isTimeout) {
        return reply.code(504).send({
          error: "timeout",
          message: `Agent did not complete within ${timeoutMs}ms`,
          partial_output: partialOutput || undefined,
          duration_ms: Date.now() - start,
        });
      }

      // Everything else (TuttiError subclasses, provider failures, etc.)
      // propagates to the global error handler.
      throw err;
    }
  });
}

/** Shape returned to `POST /run` regardless of agent vs graph mode. */
interface RunResult {
  output: string;
  session_id: string;
  turns: number;
  usage: { input_tokens: number; output_tokens: number };
}

/**
 * Dispatch the request to the graph runner or the agent runner. Both
 * paths converge on the same {@link RunResult} shape so the route can
 * reply with one body schema.
 */
async function runEntry(
  runtime: TuttiRuntime,
  graph: TuttiGraph | undefined,
  agentName: string,
  body: RunBody,
): Promise<RunResult> {
  const { input, session_id: sessionId } = body;
  if (!graph) {
    const result = await runtime.run(agentName, input, sessionId, conversationOf(body));
    return {
      output: result.output,
      session_id: result.session_id,
      turns: result.turns,
      usage: result.usage,
    };
  }

  // Graph runs don't auto-allocate a session, but the studio canvas
  // needs one to correlate events. Generate when the caller didn't
  // supply one.
  const session_id = sessionId ?? randomUUID();
  const result = await graph.run(input, { session_id });
  return {
    output: result.final_output,
    session_id,
    turns: result.path.length,
    usage: result.total_usage,
  };
}
