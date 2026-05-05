import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";

import type { TuttiGraph, TuttiRuntime } from "@tuttiai/core";
import type { SessionsRegistry } from "../sessions-registry.js";

/**
 * Register the session inspection / time-travel routes:
 *
 * - `GET /sessions` — list every session this server has seen, newest first.
 * - `GET /sessions/:id` — full session payload (existing).
 * - `GET /sessions/:id/turns` — just the message array, for the studio's replay view.
 * - `POST /sessions/:id/replay-from` — truncate history at `turn_index` and rerun.
 *
 * @param app       - Fastify instance.
 * @param runtime   - Runtime that owns the session store + agent runner.
 * @param registry  - In-memory directory of sessions seen by this server.
 * @param agentName - Default agent (used when a session was created in agent mode).
 * @param graph     - Optional graph runner — when set, `replay-from` runs the graph.
 */
export function registerSessionsRoute(
  app: FastifyInstance,
  runtime: TuttiRuntime,
  registry?: SessionsRegistry,
  agentName?: string,
  graph?: TuttiGraph,
): void {
  app.get("/sessions", () => {
    return registry?.list() ?? [];
  });

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

  app.get<{ Params: { id: string } }>(
    "/sessions/:id/turns",
    async (request, reply) => {
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
        count: session.messages.length,
      });
    },
  );

  app.post<{
    Params: { id: string };
    Body: { turn_index: number; input?: string };
  }>(
    "/sessions/:id/replay-from",
    {
      schema: {
        body: {
          type: "object",
          required: ["turn_index"],
          properties: {
            turn_index: { type: "integer", minimum: 0 },
            input: { type: "string" },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const session = runtime.getSession(request.params.id);
      if (!session) {
        return reply.code(404).send({
          error: "session_not_found",
          message: `No session with id "${request.params.id}"`,
        });
      }

      const { turn_index, input: overrideInput } = request.body;
      if (turn_index > session.messages.length) {
        return reply.code(400).send({
          error: "invalid_turn_index",
          message: `turn_index ${turn_index} is past the end of the session (${session.messages.length} messages).`,
        });
      }

      // Pick the input: caller override > the message at turn_index > error.
      const input = overrideInput ?? extractInput(session.messages, turn_index);
      if (input === undefined) {
        return reply.code(400).send({
          error: "no_replay_input",
          message:
            "Could not derive an input from the selected turn. Pass `input` in the request body.",
        });
      }

      // Truncate history. This requires the in-memory store's `save()`
      // method — Postgres-backed stores would need a per-driver path
      // that's beyond this step's scope.
      const truncated = session.messages.slice(0, turn_index);
      const store = runtime.sessions as {
        save?: (s: {
          id: string;
          agent_name: string;
          messages: typeof truncated;
          created_at: Date;
          updated_at: Date;
        }) => void;
      };
      if (typeof store.save === "function") {
        store.save({
          id: session.id,
          agent_name: session.agent_name,
          messages: truncated,
          created_at: session.created_at,
          updated_at: new Date(),
        });
      }

      // Run the rest. Graph mode generates a fresh session_id on the
      // top-level run so the studio canvas treats it as a new run; the
      // truncated history seeded above stays intact for the rerun's
      // first node.
      if (graph) {
        const new_session_id = randomUUID();
        const result = await graph.run(input, { session_id: new_session_id });
        return reply.code(200).send({
          session_id: new_session_id,
          replayed_from: turn_index,
          truncated_to: truncated.length,
          output: result.final_output,
          turns: result.path.length,
          path: result.path,
        });
      }

      const result = await runtime.run(agentName ?? session.agent_name, input, session.id);
      return reply.code(200).send({
        session_id: result.session_id,
        replayed_from: turn_index,
        truncated_to: truncated.length,
        output: result.output,
        turns: result.turns,
      });
    },
  );
}

/**
 * Pull a string input from message at `turn_index`. Returns `undefined`
 * when the message has no plain-text content (caller should pass
 * `input` explicitly in that case).
 */
function extractInput(
  messages: ReadonlyArray<{ role: string; content: unknown }>,
  turn_index: number,
): string | undefined {
  // `turn_index` was just bounded against `session.messages.length` by the
  // route handler — array indexing here can't escape into prototype space.
  // eslint-disable-next-line security/detect-object-injection
  const msg = messages[turn_index];
  if (!msg) return undefined;
  if (typeof msg.content === "string") return msg.content;
  if (!Array.isArray(msg.content)) return undefined;
  const text = msg.content
    .filter((b): b is { type: "text"; text: string } =>
      typeof b === "object" &&
      b !== null &&
      (b as { type?: unknown }).type === "text" &&
      typeof (b as { text?: unknown }).text === "string",
    )
    .map((b) => b.text)
    .join("\n")
    .trim();
  return text.length > 0 ? text : undefined;
}
