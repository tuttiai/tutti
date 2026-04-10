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
}
