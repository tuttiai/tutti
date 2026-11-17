import type { ChatMessage, Session, SessionStore } from "@tuttiai/types";

import { FileSessionStore } from "../file-session-store.js";
import { logger } from "../logger.js";
import { InMemorySessionStore } from "../session-store.js";

/**
 * Write a finished run's history back to its session. A run reads its session
 * once, at the start, so one that waited on an approval or a frozen host past
 * the store's idle time to live finds the session evicted by the time it
 * finishes, after its tools have already run. The built-in stores accept a
 * caller-chosen id, so the session is put back under its own id rather than
 * failing the run; any other store is written as before.
 *
 * @param store - The store the run's session came from.
 * @param session - The session the run read at its start.
 * @param messages - The run's full history, to keep.
 * @throws {Error} When the session is gone and the store cannot take it back.
 */
export function writeBack(store: SessionStore, session: Session, messages: ChatMessage[]): void {
  const restorable = store instanceof InMemorySessionStore || store instanceof FileSessionStore;
  if (!restorable || store.get(session.id) !== undefined) {
    store.update(session.id, messages);
    return;
  }
  logger.warn({ session: session.id }, "Session expired while its run waited; restoring it under its id");
  store.save({ ...session, messages, updated_at: new Date() });
}
