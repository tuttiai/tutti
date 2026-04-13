/** Public types for the checkpoint persistence layer. */

import type { ChatMessage, ToolResult } from "@tuttiai/types";

/**
 * Transient runtime state captured in a checkpoint alongside the message
 * history. Distinct from the `Session` record because `Session` is just
 * id + messages + timestamps — it doesn't carry the counters the agent
 * loop needs to resume without double-charging budgets or double-running
 * tools.
 *
 * Fields are deliberately narrow and additive: new durable-resume needs
 * grow this type, old checkpoints stay readable via optional fields.
 */
export interface SessionState {
  /** Turn number the runner was about to execute next when the checkpoint was taken. */
  next_turn: number;
  /** Prompt tokens consumed so far this session. */
  prompt_tokens_used: number;
  /** Completion tokens consumed so far this session. */
  completion_tokens_used: number;
  /** Estimated cost in USD incurred so far this session. */
  cost_usd_used?: number;
  /** Tool-call IDs that were in-flight at checkpoint time (for at-most-once resume). */
  pending_tool_ids?: string[];
  /**
   * `true` when the previous turn ended on `tool_use` and the checkpoint is
   * mid-cycle — the runner should feed the `tool_results` back to the LLM
   * before taking a new user turn. `false` when the checkpoint sits on a
   * clean boundary.
   */
  awaiting_tool_results?: boolean;
}

/**
 * A durable snapshot of an agent session at a specific turn boundary.
 *
 * Every checkpoint is self-sufficient: given the checkpoint and the agent's
 * score, a fresh runtime can resume the conversation without any other
 * state.
 */
export interface Checkpoint {
  session_id: string;
  /** Zero-based turn index the checkpoint corresponds to. */
  turn: number;
  /** Full message history up to and including `turn`. */
  messages: ChatMessage[];
  /**
   * Tool results emitted during `turn`. Empty when the turn ended with a
   * text-only assistant message.
   */
  tool_results: ToolResult[];
  /** Runtime counters needed to resume without replaying the whole log. */
  state: SessionState;
  /** Wall-clock time the checkpoint was persisted. */
  saved_at: Date;
}
