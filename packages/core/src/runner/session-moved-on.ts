import type { Session, SessionStore } from "@tuttiai/types";

import { TuttiError } from "../errors.js";
import { logger } from "../logger.js";

/**
 * What a run saw of its session when it started. Plain values, because the
 * in-memory store hands out its live object, which a later write changes in place.
 */
export interface SessionMark {
  /** Messages in the session's history. */
  length: number;
  /** The session's `updated_at`, in epoch milliseconds. */
  updated_ms: number;
}

/**
 * Take a {@link SessionMark} of a session as a run starts on it.
 *
 * @param session - The session the run read at its start.
 * @returns Its history length and last update time.
 */
export function sessionMark(session: Session): SessionMark {
  return { length: session.messages.length, updated_ms: session.updated_at.getTime() };
}

/**
 * Whether another run has written the session since `mark` was taken. Both the
 * length and the time are compared: a write-back always adds to the history,
 * and a frozen or coarse clock can leave `updated_at` where it was. A session
 * that is gone has not moved on, so the write-back can restore it (#131).
 *
 * @param store - The store the run's session came from.
 * @param id - The session id.
 * @param mark - What the run saw at its start.
 * @returns `true` when the stored session no longer matches the mark.
 */
export async function movedOn(store: SessionStore, id: string, mark: SessionMark): Promise<boolean> {
  const current = store.get(id) ?? (await store.load?.(id));
  if (current === undefined) return false;
  return current.messages.length !== mark.length || current.updated_at.getTime() !== mark.updated_ms;
}

/**
 * Stop a durable run from finishing a turn that another run of its session has
 * already finished, for example a second runtime that resumed it from its
 * checkpoint while this host was paused (#133). Called just before the write-back.
 *
 * @param store - The store the run's session came from.
 * @param id - The session id.
 * @param mark - What the run saw at its start.
 * @throws {TuttiError} With code `RUN_SUPERSEDED` when the session has moved on.
 */
export async function refuseIfMovedOn(store: SessionStore, id: string, mark: SessionMark): Promise<void> {
  if (!(await movedOn(store, id, mark))) return;
  logger.warn({ session: id }, "Another run finished this session while the durable run was held; dropping its result");
  throw new TuttiError(
    "RUN_SUPERSEDED",
    `Session "${id}" was finished by another run while this durable run was held, so its result was not saved.\n` +
      `Read the session for the turn that completed, or start a new run on it.`,
    { session_id: id },
  );
}
