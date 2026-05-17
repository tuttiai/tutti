/** Event types for the observability EventBus. */

import type { ChatRequest, ChatResponse } from "./llm.js";
import type { ToolResult } from "./voice.js";

export type TuttiEvent =
  | { type: "agent:start"; agent_name: string; session_id: string }
  | { type: "agent:end"; agent_name: string; session_id: string }
  | { type: "llm:request"; agent_name: string; request: ChatRequest }
  | { type: "llm:response"; agent_name: string; response: ChatResponse }
  | { type: "tool:start"; agent_name: string; tool_name: string; input: unknown }
  | { type: "tool:end"; agent_name: string; tool_name: string; result: ToolResult }
  | { type: "tool:error"; agent_name: string; tool_name: string; error: Error }
  | { type: "turn:start"; agent_name: string; session_id: string; turn: number }
  | { type: "turn:end"; agent_name: string; session_id: string; turn: number }
  | { type: "delegate:start"; from: string; to: string; task: string }
  | { type: "delegate:end"; from: string; to: string; output: string }
  | { type: "parallel:start"; agents: string[] }
  | { type: "parallel:complete"; results: string[] }
  | { type: "cache:hit"; agent_name: string; tool: string }
  | { type: "cache:miss"; agent_name: string; tool: string }
  | { type: "security:injection_detected"; agent_name: string; tool_name: string; patterns: string[] }
  | {
      type: "budget:warning";
      agent_name: string;
      tokens: number;
      cost_usd: number;
      /** Window the warning applies to. Absent for legacy emitters that
       *  predate daily/monthly aggregation; treat as `'run'` then. */
      scope?: "run" | "day" | "month";
      /** Configured ceiling for `scope`, in USD. Absent on warnings
       *  emitted from the legacy token-based path. */
      limit?: number;
    }
  | {
      type: "budget:exceeded";
      agent_name: string;
      tokens: number;
      cost_usd: number;
      scope?: "run" | "day" | "month";
      limit?: number;
    }
  | { type: "token:stream"; agent_name: string; text: string }
  | { type: "hitl:requested"; agent_name: string; session_id: string; question: string; options?: string[] }
  | { type: "hitl:answered"; agent_name: string; session_id: string; answer: string }
  | { type: "hitl:timeout"; agent_name: string; session_id: string }
  | { type: "checkpoint:saved"; session_id: string; turn: number }
  | { type: "checkpoint:restored"; session_id: string; turn: number }
  | { type: "schedule:triggered"; schedule_id: string; agent_name: string }
  | { type: "schedule:completed"; schedule_id: string; agent_name: string; duration_ms: number }
  | { type: "schedule:error"; schedule_id: string; agent_name: string; error: Error }
  /**
   * Emitted after a scheduled run's text output is successfully handed
   * off to the dispatch wrapper for the configured `deliver.platform`.
   * `target` is the addressing field for that platform (channel id,
   * email address, etc.), redacted of any token-like content.
   * `chars` is the dispatched payload length AFTER format transformation.
   */
  | {
      type: "schedule:delivered";
      agent_name: string;
      platform: "slack" | "discord" | "telegram" | "email" | "whatsapp";
      target: string;
      chars: number;
    }
  /**
   * Emitted when dispatch to the configured `deliver` target fails. The
   * scheduled run itself completed — delivery is a side effect, so the
   * agent's output is still recorded on the run. `error` is redacted via
   * SecretsManager before emission.
   */
  | {
      type: "schedule:delivery_failed";
      agent_name: string;
      platform: "slack" | "discord" | "telegram" | "email" | "whatsapp";
      target: string;
      error: string;
    }
  | {
      type: "interrupt:requested";
      session_id: string;
      tool_name: string;
      interrupt_id: string;
      tool_args: unknown;
    }
  | {
      type: "interrupt:resolved";
      session_id: string;
      tool_name: string;
      interrupt_id: string;
      status: "approved" | "denied";
      denial_reason?: string;
      resolved_by?: string;
    }
  /**
   * Emitted by `AgentRunner` whenever a `@tuttiai/router` `SmartProvider`
   * makes a routing decision. Mirrors the fields of `RoutingDecision`
   * inline so `@tuttiai/types` does not need to depend on
   * `@tuttiai/router`.
   */
  | {
      type: "router:decision";
      agent_name: string;
      tier: string;
      model: string;
      reason: string;
      classifier: string;
      estimated_input_tokens: number;
      estimated_cost_usd: number;
      /**
       * Number of `destructive: true` tools loaded on the agent at the
       * time of the decision. Lets consumers correlate routing choices
       * with the agent's blast radius. Only present when emitted from
       * inside `AgentRunner` (the source of truth for the count).
       */
      destructive_tool_count?: number;
    }
  /**
   * Emitted when a `SmartProvider`'s primary tier throws and the
   * configured `fallback` tier handles the call instead.
   */
  | {
      type: "router:fallback";
      agent_name: string;
      from_model: string;
      to_model: string;
      error: string;
    }
  /**
   * Emitted whenever a semantic memory entry is written, read, or
   * deleted — whether through the curated `remember` / `recall` /
   * `forget` agent tools or via {@link ToolMemoryHelpers} from
   * user-defined tool code. Both surfaces share the same enforcement
   * pipeline, so subscribers see one event stream.
   *
   * `memory:write` — `entry_id` is the new id; `source` is `"agent"`
   *   for curated-tool writes, `"system"` for everything else.
   * `memory:read` — `result_count` is the number of entries returned
   *   (0 for misses).
   * `memory:delete` — fires for explicit `forget` calls and for
   *   automatic LRU eviction. `reason` discriminates them.
   */
  | {
      type: "memory:write";
      agent_name: string;
      entry_id: string;
      source: "agent" | "system";
      tags?: string[];
    }
  | {
      type: "memory:read";
      agent_name: string;
      query: string;
      result_count: number;
    }
  | {
      type: "memory:delete";
      agent_name: string;
      entry_id: string;
      reason: "explicit" | "lru_eviction";
    }
  /**
   * Emitted when the dialectic user-model consolidator successfully
   * refreshes a user's rolling profile. `turn_count` is the user's
   * cumulative turn counter at the time of consolidation — also the
   * value the consolidator wrote to `last_consolidated_turn`. Subscribe
   * for telemetry or to trigger downstream syncs (e.g. push the new
   * profile to an external personalisation store).
   */
  | {
      type: "user_model:consolidated";
      user_id: string;
      turn_count: number;
    }
  /**
   * Emitted by `@tuttiai/inbox` when an inbound message arrives from a
   * platform adapter (Telegram, Slack, Discord, ...) and has passed
   * allow-list and rate-limit checks. The `agent_name` is the inbox's
   * configured handler agent. `platform_chat_id` is the platform's
   * chat/channel/thread id; `platform_user_id` is the platform's user
   * id. `text_length` is in characters, not tokens — the message text
   * itself is intentionally NOT included to avoid PII leakage into
   * logs and telemetry; subscribe to the adapter directly if you need
   * the raw text.
   */
  | {
      type: "inbox:message_received";
      agent_name: string;
      platform: string;
      platform_user_id: string;
      platform_chat_id: string;
      text_length: number;
    }
  /**
   * Emitted after a successful agent run originated from an inbox
   * message and the reply has been handed back to the adapter for
   * delivery. `duration_ms` measures the full agent run, not the
   * adapter delivery latency. `session_id` is the Tutti session that
   * handled the message; consumers can correlate this with
   * `agent:start`/`agent:end` events.
   */
  | {
      type: "inbox:message_replied";
      agent_name: string;
      platform: string;
      platform_chat_id: string;
      session_id: string;
      duration_ms: number;
    }
  /**
   * Emitted when an inbound message is dropped before reaching the
   * agent. `reason` discriminates: `"not_allowlisted"` (sender not in
   * `allowedUsers`), `"rate_limited"` (token-bucket exhausted for the
   * sender), `"queue_full"` (per-chat queue at capacity), or
   * `"empty_text"` (no text content to dispatch — attachments-only
   * messages are dropped in v0.25 and re-enabled when adapter support
   * lands).
   */
  | {
      type: "inbox:message_blocked";
      platform: string;
      platform_user_id: string;
      platform_chat_id: string;
      reason: "not_allowlisted" | "rate_limited" | "queue_full" | "empty_text";
    }
  /**
   * Emitted when the inbox or one of its adapters caught an error
   * processing an inbound message. Errors do NOT crash the inbox —
   * subscribers should treat this as observability, not control flow.
   * `error_message` is redacted via SecretsManager before emission.
   */
  | {
      type: "inbox:error";
      platform: string;
      /** Optional — absent if the error was raised before the message was parsed. */
      platform_chat_id?: string;
      /** Stage at which the error occurred. */
      stage: "receive" | "dispatch" | "reply";
      error_message: string;
    }
  /**
   * Emitted by `@tuttiai/skills` when a synthesiser proposes a new skill
   * candidate, before any human review. Subscribers typically forward
   * this to a review UI or notification channel.
   */
  | {
      type: "skill:candidate_proposed";
      candidate_id: string;
      name_suggestion: string;
      /** Number of trajectories backing the proposal. */
      evidence_count: number;
    }
  /**
   * Emitted by the runtime's `SkillProposer` immediately after a new
   * `SkillCandidate` is persisted. Carries the originating `agent_name`
   * so subscribers can scope review UIs and notifications per agent —
   * `skill:candidate_proposed` is store-level and agent-agnostic, this
   * event is the runtime-level companion.
   */
  | {
      type: "skill:proposed";
      agent_name: string;
      candidate_id: string;
      name_suggestion: string;
      /** Number of trajectories backing the proposal. */
      evidence_count: number;
    }
  /** Emitted when an operator approves a candidate and it becomes a skill. */
  | {
      type: "skill:approved";
      skill_id: string;
      name: string;
      /** Operator identifier — absent when approved programmatically. */
      reviewed_by?: string;
    }
  /** Emitted when an operator rejects a candidate. */
  | {
      type: "skill:rejected";
      candidate_id: string;
      /** Operator identifier — absent when rejected programmatically. */
      reviewed_by?: string;
      /** Free-text reason — absent if the reviewer left it empty. */
      reason?: string;
    }
  /**
   * Emitted by the runtime's `TrajectoryObserver` after a completed run is
   * persisted to the configured `SkillStore`. `tool_count` is the length of
   * the recorded `tool_calls` array — post-truncation when the observer's
   * `maxToolCallsPerRun` cap fired. Runs that fell below the duration
   * threshold do not emit this event.
   */
  | {
      type: "skill:trajectory_recorded";
      agent_name: string;
      trajectory_id: string;
      tool_count: number;
    }
  /**
   * Emitted by the runtime's `SkillExecutor` when an approved skill is
   * invoked as a tool inside an agent run. `run_id` is the per-run
   * identifier the runtime threads into the executor when it materialises
   * tools at run start; it matches the trajectory id the
   * `TrajectoryObserver` later records for the same run, so subscribers
   * can correlate skill invocations with the parent run's trajectory.
   */
  | {
      type: "skill:invoked";
      agent_name: string;
      skill_id: string;
      run_id: string;
    };

export type TuttiEventType = TuttiEvent["type"];

export type TuttiEventHandler<T extends TuttiEventType = TuttiEventType> = (
  event: Extract<TuttiEvent, { type: T }>
) => void;
