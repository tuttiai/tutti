/** Session types for conversation state management. */

import type { ChatMessage } from "./llm.js";

export interface Session {
  id: string;
  agent_name: string;
  messages: ChatMessage[];
  created_at: Date;
  updated_at: Date;
}

export interface SessionStore {
  create(agent_name: string): Session;
  get(id: string): Session | undefined;
  update(id: string, messages: ChatMessage[]): void;
  /**
   * Fetch a session `get` does not hold, from wherever the store keeps
   * sessions durably (a database, another process's disk). Optional: a
   * store whose `get` already sees everything it holds leaves it out.
   *
   * The runtime awaits it only after `get` misses, before reporting a
   * session as not found. A session it returns must then be visible to
   * `get` and accepted by `update`, because the run that follows writes
   * its history back through them.
   *
   * @param id - The session id.
   * @returns The session, or `undefined` when the store holds none by that id.
   */
  load?(id: string): Promise<Session | undefined>;
}
