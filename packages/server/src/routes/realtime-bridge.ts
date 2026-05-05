/**
 * Frame translation between the browser WebSocket and a
 * {@link RealtimeSession}. Split from `realtime.ts` to keep each file
 * under the 200-line ceiling; not part of the public API.
 *
 * Inbound frames (browser → server) are translated into client method
 * calls on the session. Outbound frames (server → browser) are emitted
 * by subscribing to the session's typed events. Errors that escape are
 * redacted before they reach the wire.
 */

import { SecretsManager } from "@tuttiai/core";
import type { RealtimeSession } from "@tuttiai/realtime";
import type { WebSocket } from "ws";

/** Inbound frames the browser sends. */
export type InboundFrame =
  | { type: "audio"; data: string }
  | { type: "audio_commit" }
  | { type: "text"; content: string }
  | {
      type: "interrupt:resolve";
      interrupt_id: string;
      status: "approved" | "denied";
      reason?: string;
    };

/** Outbound frames the server sends. */
export type OutboundFrame =
  | { type: "ready"; model: string; voice: string }
  | { type: "audio"; data: string; transcript?: string }
  | { type: "transcript"; role: "user" | "assistant"; text: string }
  | { type: "tool:call"; name: string; args: unknown }
  | {
      type: "tool:result";
      name: string;
      result: { content: string; is_error?: boolean };
    }
  | {
      type: "interrupt";
      interrupt_id: string;
      tool_name: string;
      tool_args: unknown;
    }
  | { type: "error"; message: string }
  | { type: "end"; reason: string };

/** Stringify and write an outbound frame; silent drop on closed sockets. */
export function send(socket: WebSocket, frame: OutboundFrame): void {
  try {
    socket.send(JSON.stringify(frame));
  } catch {
    // Socket may have closed mid-fan-out; the close event handler will
    // tear the session down on the next tick — nothing useful to log.
  }
}

/**
 * Subscribe every {@link RealtimeSession} event to a corresponding
 * outbound WebSocket frame. The session's own `on()` returns
 * unsubscribe functions, but we let session.close() drop them — there
 * is exactly one socket per session, so the lifetimes are coupled.
 */
export function wireSessionToSocket(session: RealtimeSession, socket: WebSocket): void {
  session.on("audio", (e) => send(socket, { type: "audio", data: e.delta }));
  session.on("transcript", (e) =>
    send(socket, { type: "transcript", role: e.role, text: e.text }),
  );
  session.on("tool:call", (e) =>
    send(socket, { type: "tool:call", name: e.tool_name, args: e.input }),
  );
  session.on("tool:result", (e) =>
    send(socket, { type: "tool:result", name: e.tool_name, result: e.result }),
  );
  session.on("interrupt", (e) =>
    send(socket, {
      type: "interrupt",
      interrupt_id: e.interrupt_id,
      tool_name: e.tool_name,
      tool_args: e.tool_args,
    }),
  );
  session.on("error", (e) =>
    send(socket, { type: "error", message: SecretsManager.redact(e.error.message) }),
  );
  session.on("end", (e) => send(socket, { type: "end", reason: e.reason }));
}

/**
 * Parse and dispatch one inbound frame. Bad frames are reported on the
 * socket and dropped — the session continues so a single malformed
 * frame doesn't poison the whole connection.
 */
export function handleInbound(
  raw: string,
  session: RealtimeSession,
  socket: WebSocket,
): void {
  let frame: InboundFrame;
  try {
    frame = JSON.parse(raw) as InboundFrame;
  } catch {
    send(socket, { type: "error", message: "Malformed JSON frame." });
    return;
  }
  switch (frame.type) {
    case "audio":
      session.sendAudio(Buffer.from(frame.data, "base64"));
      return;
    case "audio_commit":
      // RealtimeSession does not expose commit directly; the browser
      // demo can rely on server VAD instead. Calling through the
      // session's underlying client preserves a non-VAD escape hatch.
      (
        session as unknown as { client: { commitAudio(): void } }
      ).client.commitAudio();
      return;
    case "text":
      session.sendText(frame.content);
      return;
    case "interrupt:resolve":
      void session
        .resolveInterrupt(
          frame.interrupt_id,
          frame.status,
          frame.reason !== undefined ? { denial_reason: frame.reason } : {},
        )
        .catch((err: unknown) =>
          send(socket, {
            type: "error",
            message: SecretsManager.redact(
              err instanceof Error ? err.message : String(err),
            ),
          }),
        );
      return;
    default:
      send(socket, { type: "error", message: "Unknown frame type." });
  }
}

/**
 * Constant-time bearer-token check for the `?api_key=` query string.
 * Mirrors `middleware/auth.ts`'s `timingSafeEqual` so the realtime path
 * has the same side-channel resistance as bearer-authenticated routes.
 */
export function authorize(
  queryKey: string | undefined,
  expected: string | undefined,
): boolean {
  if (expected === undefined) return false;
  if (typeof queryKey !== "string" || queryKey.length !== expected.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < queryKey.length; i++) {
    diff |= queryKey.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}
