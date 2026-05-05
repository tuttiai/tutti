/**
 * Reader-side helper that returns a realtime session's full transcript
 * in standard Tutti turn format — the same `ChatMessage[]` shape that
 * `GET /sessions/:id/turns` and `tutti-ai traces` already consume.
 *
 * The spec called for a single-arg signature `getRealtimeTranscript(sessionId)`,
 * but Tutti's checkpoint stores are explicit dependencies (no module-level
 * singleton), so the store is a required second parameter — same convention
 * as every other store-backed helper in `@tuttiai/core`.
 */

import type { CheckpointStore } from "@tuttiai/core";
import type { ChatMessage } from "@tuttiai/types";

/**
 * Read the latest persisted transcript for a realtime session.
 *
 * Returns `[]` when no checkpoint exists — distinguishes "session never
 * recorded anything" from "session id unknown" intentionally weakly so
 * callers don't have to special-case missing sessions.
 *
 * @param session_id - The realtime session's id (matches `RealtimeSessionOptions.session_id`).
 * @param store - The checkpoint store the session was configured with.
 */
export async function getRealtimeTranscript(
  session_id: string,
  store: CheckpointStore,
): Promise<ChatMessage[]> {
  const latest = await store.loadLatest(session_id);
  return latest?.messages ?? [];
}
