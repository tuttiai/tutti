import { randomUUID } from "node:crypto";

import type { Session, SessionStore, ChatMessage } from "@tuttiai/types";

import { SessionLru, type SessionStoreBounds } from "./session-lru.js";

/** Options for {@link InMemorySessionStore}. */
export type InMemorySessionStoreOptions = SessionStoreBounds;

/**
 * Keeps sessions in this process's memory. Bounded: a session unused for
 * `idle_ttl_ms` (default 24 hours) is evicted, and over `max_sessions`
 * (default 1000) the least recently used goes first, so a long-lived server
 * that keeps reusing sessions does not grow without limit. Everything is lost
 * when the process exits; `FileSessionStore` keeps sessions on disk instead.
 *
 * @example
 * const runtime = new TuttiRuntime(score, {
 *   sessionStore: new InMemorySessionStore({ max_sessions: 200 }),
 * });
 */
export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, Session>();
  private readonly lru: SessionLru;

  /**
   * @param options - Cap, idle time to live and clock. Every field is optional.
   */
  constructor(options: InMemorySessionStoreOptions = {}) {
    this.lru = new SessionLru(options, (id) => this.sessions.delete(id));
  }

  create(agent_name: string): Session {
    const session: Session = {
      id: randomUUID(),
      agent_name,
      messages: [],
      created_at: new Date(),
      updated_at: new Date(),
    };
    this.sessions.set(session.id, session);
    this.lru.touch(session.id);
    return session;
  }

  get(id: string): Session | undefined {
    if (!this.lru.isLive(id)) return undefined;
    const session = this.sessions.get(id);
    if (session) this.lru.touch(id);
    return session;
  }

  update(id: string, messages: ChatMessage[]): void {
    const session = this.get(id);
    if (!session) {
      throw new Error(`Session not found: ${id}`);
    }
    session.messages = messages;
    session.updated_at = new Date();
  }

  /**
   * Insert-or-replace a session with a caller-supplied id. Used by resume
   * flows that need to rehydrate a session read from an external store
   * (e.g. a checkpoint) under its original id. Not part of the
   * `SessionStore` interface — callers must opt in explicitly.
   */
  save(session: Session): void {
    this.sessions.set(session.id, session);
    this.lru.touch(session.id);
  }
}
