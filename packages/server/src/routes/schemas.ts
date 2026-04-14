/**
 * Shared JSON Schema definitions and TypeScript types for route handlers.
 *
 * Fastify validates request bodies against these schemas before the handler
 * runs, so handlers can trust the shape without additional Zod parsing.
 */

/** Request body accepted by both `POST /run` and `POST /run/stream`. */
export interface RunBody {
  input: string;
  session_id?: string;
  config?: Record<string, unknown>;
}

/**
 * Fastify-native JSON Schema for {@link RunBody}.
 *
 * `config` is accepted as a free-form object; the server validates its
 * presence but does not yet apply per-request overrides.
 */
export const runBodySchema = {
  type: "object",
  required: ["input"],
  properties: {
    input: { type: "string", minLength: 1 },
    session_id: { type: "string" },
    config: { type: "object" },
  },
  additionalProperties: false,
} as const;
