import type { Session, SessionStore, ChatMessage } from "@tuttiai/types";
import { randomUUID } from "node:crypto";

export class InMemorySessionStore implements SessionStore {
  private sessions = new Map<string, Session>();

  create(agent_name: string): Session {
    const session: Session = {
      id: randomUUID(),
      agent_name,
      messages: [],
      created_at: new Date(),
      updated_at: new Date(),
    };
    this.sessions.set(session.id, session);
    return session;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  update(id: string, messages: ChatMessage[]): void {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error(`Session not found: ${id}`);
    }
    session.messages = messages;
    session.updated_at = new Date();
  }
}
