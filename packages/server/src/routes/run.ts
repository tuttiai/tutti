import type { FastifyInstance } from "fastify";

import type { TuttiRuntime } from "@tuttiai/core";
import { estimateCostUsd } from "../cost.js";
import { DEFAULT_TIMEOUT_MS } from "../config.js";
import type { RunBody } from "./schemas.js";
import { runBodySchema } from "./schemas.js";

/**
 * Register `POST /run` — execute an agent to completion (non-streaming).
 *
 * @param app       - Fastify instance.
 * @param runtime   - Pre-built Tutti runtime.
 * @param agentName - Agent key in the score.
 * @param timeoutMs - Max wall-clock time before returning 504.
 */
export function registerRunRoute(
  app: FastifyInstance,
  runtime: TuttiRuntime,
  agentName: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): void {
  app.post<{ Body: RunBody }>("/run", {
    schema: { body: runBodySchema },
  }, async (request, reply) => {
    let partialOutput = "";
    const unsubStream = runtime.events.on("token:stream", (e) => {
      partialOutput += e.text;
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const start = Date.now();

    try {
      const result = await Promise.race([
        runtime.run(agentName, request.body.input, request.body.session_id),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("TIMEOUT")), timeoutMs);
        }),
      ]);

      if (timer) clearTimeout(timer);
      unsubStream();

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
      unsubStream();

      const isTimeout = err instanceof Error && err.message === "TIMEOUT";
      if (isTimeout) {
        return reply.code(504).send({
          error: "timeout",
          message: `Agent did not complete within ${timeoutMs}ms`,
          partial_output: partialOutput || undefined,
          duration_ms: Date.now() - start,
        });
      }

      const message = err instanceof Error ? err.message : "Internal server error";
      return reply.code(500).send({ error: "run_failed", message });
    }
  });
}
