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
  /** The conversation the run belongs to, passed to voices as `VoiceContext.conversation_id`. */
  conversation_id?: string;
  config?: Record<string, unknown>;
}

/**
 * The run options a request's body carries for the runtime: its conversation, when it names one.
 *
 * @param body - The validated request body.
 * @returns The options to pass to `runtime.run()`, or undefined when the body names no conversation.
 *
 * @example
 * conversationOf({ input: "Hi", conversation_id: "c-1" }); // { conversation_id: "c-1" }
 */
export function conversationOf(body: Pick<RunBody, "conversation_id">): { conversation_id: string } | undefined {
  return body.conversation_id === undefined ? undefined : { conversation_id: body.conversation_id };
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
    // A voice may build a path from it, so the alphabet is held to what a
    // directory name can carry safely, whatever the voice does with it.
    conversation_id: { type: "string", minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9_-]+$" },
    config: { type: "object" },
  },
  additionalProperties: false,
} as const;
