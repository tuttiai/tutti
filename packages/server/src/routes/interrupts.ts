import { PassThrough } from "node:stream";
import type { FastifyInstance } from "fastify";

import type { InterruptRequest, TuttiRuntime } from "@tuttiai/core";
import type { TuttiEvent } from "@tuttiai/types";

/** Shape of the JSON body for `POST /interrupts/:interruptId/approve`. */
interface ApproveBody {
  resolved_by?: string;
}

/** Shape of the JSON body for `POST /interrupts/:interruptId/deny`. */
interface DenyBody {
  reason?: string;
  /** Optional — who denied. Same semantics as approve's field. */
  resolved_by?: string;
}

const approveBodySchema = {
  type: "object",
  properties: {
    resolved_by: { type: "string", maxLength: 512 },
  },
  additionalProperties: false,
} as const;

const denyBodySchema = {
  type: "object",
  properties: {
    reason: { type: "string", maxLength: 4_096 },
    resolved_by: { type: "string", maxLength: 512 },
  },
  additionalProperties: false,
} as const;

/**
 * Serialise an {@link InterruptRequest} for the wire. `requested_at` /
 * `resolved_at` become ISO strings so JSON round-trips cleanly without
 * callers having to revive dates.
 */
function toJson(req: InterruptRequest): Record<string, unknown> {
  return {
    interrupt_id: req.interrupt_id,
    session_id: req.session_id,
    tool_name: req.tool_name,
    tool_args: req.tool_args,
    requested_at: req.requested_at.toISOString(),
    status: req.status,
    ...(req.resolved_at !== undefined ? { resolved_at: req.resolved_at.toISOString() } : {}),
    ...(req.resolved_by !== undefined ? { resolved_by: req.resolved_by } : {}),
    ...(req.denial_reason !== undefined ? { denial_reason: req.denial_reason } : {}),
  };
}

/**
 * Register the `/interrupts` and `/sessions/:sessionId/interrupts`
 * route family. All routes 404 with a clear message when the runtime
 * has no `interruptStore` configured, rather than silently accepting
 * requests that can never be fulfilled.
 *
 * - `GET /sessions/:sessionId/interrupts` — every request for one
 *   session (all statuses), oldest first.
 * - `GET /interrupts/pending` — every pending request across every
 *   session. Powers dashboards; oldest first.
 * - `POST /interrupts/:interruptId/approve` — mark a pending request
 *   as approved; resumes the suspended tool call.
 * - `POST /interrupts/:interruptId/deny` — mark a pending request as
 *   denied; throws `InterruptDeniedError` into the waiting run.
 * - `GET /interrupts/stream` — Server-Sent Events. Forwards every
 *   `interrupt:requested` and `interrupt:resolved` event as a JSON
 *   frame of `{ type, data: InterruptRequest }`. Fetches the full
 *   record from the store on each event so the payload is authoritative.
 *
 * SSE (not WebSocket) matches the existing `/run/stream` and
 * `/traces/stream` transport in this server. Same semantics for
 * one-way server→client broadcast, no new dep.
 */
export function registerInterruptsRoutes(
  app: FastifyInstance,
  runtime: TuttiRuntime,
): void {
  // Small helper — every route except `/stream` can bail out the same way.
  type RequireStoreResult =
    | { ok: false; error: { error: string; message: string } }
    | { ok: true; store: NonNullable<TuttiRuntime["interruptStore"]> };
  const requireStore = (): RequireStoreResult => {
    const store = runtime.interruptStore;
    if (!store) {
      return {
        ok: false,
        error: {
          error: "interrupt_store_not_configured",
          message:
            "This runtime has no InterruptStore. Pass one via " +
            "TuttiRuntimeOptions.interruptStore to enable requireApproval.",
        },
      };
    }
    return { ok: true, store };
  };

  // ── GET /sessions/:sessionId/interrupts ──────────────────────
  app.get<{ Params: { sessionId: string } }>(
    "/sessions/:sessionId/interrupts",
    async (request, reply) => {
      const r = requireStore();
      if (!r.ok) return reply.code(503).send(r.error);
      const rows = await r.store.listBySession(request.params.sessionId);
      return reply.code(200).send({
        session_id: request.params.sessionId,
        interrupts: rows.map(toJson),
      });
    },
  );

  // ── GET /interrupts/pending ──────────────────────────────────
  app.get("/interrupts/pending", async (_request, reply) => {
    const r = requireStore();
    if (!r.ok) return reply.code(503).send(r.error);
    const rows = await r.store.listPending();
    return reply.code(200).send({ interrupts: rows.map(toJson) });
  });

  // ── POST /interrupts/:interruptId/approve ────────────────────
  app.post<{ Params: { interruptId: string }; Body: ApproveBody }>(
    "/interrupts/:interruptId/approve",
    { schema: { body: approveBodySchema } },
    async (request, reply) => {
      const r = requireStore();
      if (!r.ok) return reply.code(503).send(r.error);

      const existing = await r.store.get(request.params.interruptId);
      if (!existing) {
        return reply.code(404).send({
          error: "interrupt_not_found",
          message: `No interrupt with id "${request.params.interruptId}"`,
        });
      }
      if (existing.status !== "pending") {
        return reply.code(409).send({
          error: "already_resolved",
          message:
            `Interrupt "${request.params.interruptId}" is already ${existing.status}.`,
          current: toJson(existing),
        });
      }

      const resolved = await runtime.resolveInterrupt(
        request.params.interruptId,
        "approved",
        request.body?.resolved_by !== undefined
          ? { resolved_by: request.body.resolved_by }
          : {},
      );
      return reply.code(200).send(toJson(resolved));
    },
  );

  // ── POST /interrupts/:interruptId/deny ───────────────────────
  app.post<{ Params: { interruptId: string }; Body: DenyBody }>(
    "/interrupts/:interruptId/deny",
    { schema: { body: denyBodySchema } },
    async (request, reply) => {
      const r = requireStore();
      if (!r.ok) return reply.code(503).send(r.error);

      const existing = await r.store.get(request.params.interruptId);
      if (!existing) {
        return reply.code(404).send({
          error: "interrupt_not_found",
          message: `No interrupt with id "${request.params.interruptId}"`,
        });
      }
      if (existing.status !== "pending") {
        return reply.code(409).send({
          error: "already_resolved",
          message:
            `Interrupt "${request.params.interruptId}" is already ${existing.status}.`,
          current: toJson(existing),
        });
      }

      const options: { denial_reason?: string; resolved_by?: string } = {};
      if (request.body?.reason !== undefined) options.denial_reason = request.body.reason;
      if (request.body?.resolved_by !== undefined) options.resolved_by = request.body.resolved_by;

      const resolved = await runtime.resolveInterrupt(
        request.params.interruptId,
        "denied",
        options,
      );
      return reply.code(200).send(toJson(resolved));
    },
  );

  // ── GET /interrupts/stream ──────────────────────────────────
  // SSE broadcast: every `interrupt:requested` / `interrupt:resolved`
  // event becomes one `data: { type, data: InterruptRequest }\n\n` frame.
  // We fetch the full record from the store on each event rather than
  // relying on the slim event payload so the wire shape is always
  // authoritative and matches the REST endpoints.
  app.get("/interrupts/stream", (request, reply) => {
    const store = runtime.interruptStore;
    if (!store) {
      return reply.code(503).send({
        error: "interrupt_store_not_configured",
        message:
          "This runtime has no InterruptStore. Pass one via " +
          "TuttiRuntimeOptions.interruptStore to enable the interrupt stream.",
      });
    }

    const sse = new PassThrough();
    reply.type("text/event-stream").header("Cache-Control", "no-cache");
    reply.send(sse);

    const unsub = runtime.events.onAny((e: TuttiEvent) => {
      if (e.type !== "interrupt:requested" && e.type !== "interrupt:resolved") {
        return;
      }
      // Fire-and-forget: fetch the full record, write an SSE frame.
      // Store errors don't break the stream — log-and-drop.
      void store
        .get(e.interrupt_id)
        .then((req) => {
          if (!req || sse.destroyed) return;
          sse.write(`data: ${JSON.stringify({ type: e.type, data: toJson(req) })}\n\n`);
        })
        .catch(() => {
          // Intentionally silent — per-frame store failures should not
          // tear down the entire stream. The next event has a chance.
        });
    });

    request.raw.on("close", () => {
      unsub();
      if (!sse.destroyed) sse.end();
    });
  });
}
