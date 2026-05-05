/**
 * Wire-format helpers for `@tuttiai/realtime` — parsing inbound server
 * events and building outbound payloads. Kept separate from the client
 * so the WebSocket transport stays independent of the protocol shape.
 */

import type { RealtimeConfig, RealtimeEvent } from "./types.js";

/**
 * Parse a raw inbound WebSocket payload into a {@link RealtimeEvent}.
 *
 * Returns `null` for non-string payloads (e.g. binary frames the
 * Realtime API does not send), invalid JSON, or objects missing the
 * required `type: string` discriminator. Callers should drop `null`
 * silently so a malformed frame can never crash the dispatch loop.
 */
export function parseEvent(data: unknown): RealtimeEvent | null {
  if (typeof data !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { type?: unknown }).type !== "string"
  ) {
    return null;
  }
  return parsed as RealtimeEvent;
}

/**
 * Build the `session.update` payload sent immediately after the socket
 * opens. Optional config fields are omitted (rather than sent as
 * `undefined`) so the server never sees nulls for fields the caller
 * didn't set — this keeps server-side defaults intact.
 */
export function buildSessionUpdate(config: RealtimeConfig): RealtimeEvent {
  const turnDetection: Record<string, unknown> = { type: config.turnDetection.type };
  if (config.turnDetection.threshold !== undefined) {
    turnDetection["threshold"] = config.turnDetection.threshold;
  }
  if (config.turnDetection.silenceDurationMs !== undefined) {
    turnDetection["silence_duration_ms"] = config.turnDetection.silenceDurationMs;
  }
  const session: Record<string, unknown> = {
    voice: config.voice,
    turn_detection: turnDetection,
  };
  if (config.instructions !== undefined) session["instructions"] = config.instructions;
  if (config.temperature !== undefined) session["temperature"] = config.temperature;
  if (config.maxResponseTokens !== undefined) {
    session["max_response_output_tokens"] = config.maxResponseTokens;
  }
  return { type: "session.update", session };
}

/**
 * Coerce an unknown thrown / `error`-event value into an `Error` with a
 * useful message, falling back to `fallback` when the input has none.
 */
export function toError(value: unknown, fallback: string): Error {
  if (value instanceof Error) return value;
  if (typeof value === "object" && value !== null && "message" in value) {
    const msg = (value as { message?: unknown }).message;
    if (typeof msg === "string") return new Error(msg);
  }
  return new Error(fallback);
}
