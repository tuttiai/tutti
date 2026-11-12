/** Voice — a pluggable module that gives agents tools and capabilities. */

import type { ZodType } from "zod";

export type Permission = "network" | "filesystem" | "shell" | "browser";

export interface ToolResult {
  content: string;
  is_error?: boolean;
}

/**
 * Options accepted by {@link ToolMemoryHelpers.remember}. All fields
 * are optional — callers can store a bare content string and let the
 * helper tag it with `source: "system"` by default.
 */
export interface ToolRememberOptions {
  /** Free-form metadata persisted alongside the entry. */
  metadata?: Record<string, unknown>;
  /**
   * Provenance tag for the entry. Defaults to `"system"` when called
   * from user-defined tool code. The curated `remember` tool surface
   * passes `"agent"` so self-curated facts are distinguishable from
   * system writes. See {@link MemoryEntry.source}.
   */
  source?: "agent" | "system";
  /** Free-form labels for later filtering. See {@link MemoryEntry.tags}. */
  tags?: string[];
}

export interface ToolMemoryHelpers {
  /**
   * Store a fact the agent should remember across sessions. The
   * second argument may be either a metadata record (legacy form) or
   * a {@link ToolRememberOptions} bag. The runtime narrows the value
   * based on the presence of `source` / `tags` keys; the legacy form
   * is treated as `{ metadata: <value> }` so existing callers keep
   * working.
   */
  remember(
    content: string,
    options?: ToolRememberOptions | Record<string, unknown>,
  ): Promise<{ id: string }>;
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

/**
 * One progress update a tool reports while it runs, through
 * {@link ToolContext.report_progress}. Every field is optional; the runtime
 * turns each update into one `tool:progress` event.
 */
export interface ToolProgressUpdate {
  /** Work done so far, in the unit `total` uses. */
  progress?: number;
  /** Total amount of work, when known. */
  total?: number;
  /** A short status line. The runtime redacts it and caps it at 500 characters. */
  message?: string;
  /** Id of the remote task the tool is waiting on, such as an MCP task id. */
  task_id?: string;
  /** Status of that task as the remote side reports it, for example `working`. */
  status?: string;
  /** Where the update comes from, usually the voice name. */
  source?: string;
}

export interface ToolContext {
  session_id: string;
  agent_name: string;
  /** Semantic memory helpers — only available when agent.memory.semantic.enabled is true. */
  memory?: ToolMemoryHelpers;
  /**
   * Per-end-user memory helpers — only available when the agent has
   * `memory.user_memory` configured AND the run was started with a
   * `user_id`. See {@link UserMemoryToolHelpers}.
   */
  user_memory?: UserMemoryToolHelpers;
  /** End-user identifier for the active run, if any. Mirrors {@link AgentRunOptions.user_id}. */
  user_id?: string;
  /**
   * Aborts when the run is aborted or this call passes `tool_timeout_ms`.
   * Every call gets a signal of its own. A tool that starts remote work
   * should cancel that work when it fires. Absent on older runtimes.
   */
  signal?: AbortSignal;
  /**
   * Report progress while the call runs. Each update becomes one
   * `tool:progress` event; updates after the call has ended or its signal
   * has aborted are dropped. Absent on older runtimes.
   */
  report_progress?: (update: ToolProgressUpdate) => void;
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
  /**
   * An id the caller gives that outlives one session: every run of one
   * conversation carries the same one, while each may have a session of its
   * own. A voice that keeps state across runs, such as the sandbox's working
   * directory, keys it by this when it is present and by `session_id` when it
   * is not. Opaque to the runtime.
   */
  conversation_id?: string;
}

export interface Voice {
  name: string;
  description?: string;
  tools: Tool[];
  required_permissions: Permission[];
  setup?(context: VoiceContext): Promise<void>;
  teardown?(): Promise<void>;
}
