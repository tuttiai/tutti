/** Voice — a pluggable module that gives agents tools and capabilities. */

import type { ZodType } from "zod";

export type Permission = "network" | "filesystem" | "shell" | "browser";

export interface ToolResult {
  content: string;
  is_error?: boolean;
}

export interface ToolMemoryHelpers {
  /** Store a fact the agent should remember across sessions. */
  remember(content: string, metadata?: Record<string, unknown>): Promise<void>;
  /** Search for relevant memories. */
  recall(query: string, limit?: number): Promise<{ id: string; content: string }[]>;
  /** Delete a specific memory by ID. */
  forget(id: string): Promise<void>;
}

/**
 * Per-end-user memory helpers. Available on {@link ToolContext.user_memory}
 * when the agent has `memory.user_memory` configured *and* the run was
 * started with a `user_id`. The bound user_id is implicit — tool code
 * does not pass it on every call.
 */
export interface UserMemoryToolHelpers {
  /**
   * Store an explicit memory about the current end user. Returns the
   * stored record's id so tool code can later forget or surface it.
   * Memories stored via this helper are tagged `source: "explicit"` and
   * default to `importance: 3` (high) — the tool was clearly invoked
   * with intent.
   */
  remember(
    content: string,
    options?: {
      importance?: 1 | 2 | 3;
      tags?: string[];
      expires_at?: Date;
    },
  ): Promise<{ id: string }>;
}

export interface ToolContext {
  session_id: string;
  agent_name: string;
  /** Semantic memory helpers — only available when agent.semantic_memory.enabled is true. */
  memory?: ToolMemoryHelpers;
  /**
   * Per-end-user memory helpers — only available when the agent has
   * `memory.user_memory` configured AND the run was started with a
   * `user_id`. See {@link UserMemoryToolHelpers}.
   */
  user_memory?: UserMemoryToolHelpers;
  /** End-user identifier for the active run, if any. Mirrors {@link AgentRunOptions.user_id}. */
  user_id?: string;
}

export interface Tool<T = unknown> {
  name: string;
  description: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  parameters: ZodType<T, any, any>;
  execute(input: T, context: ToolContext): Promise<ToolResult>;
  /**
   * Marks the tool as having real-world side effects that are hard to
   * undo — posting, sending, deleting, paying, etc. Runtimes with HITL
   * support may gate execution behind human approval when this is true.
   * Optional; defaults to false.
   */
  destructive?: boolean;
}

export interface VoiceContext {
  session_id: string;
  agent_name: string;
}

export interface Voice {
  name: string;
  description?: string;
  tools: Tool[];
  required_permissions: Permission[];
  setup?(context: VoiceContext): Promise<void>;
  teardown?(): Promise<void>;
}
