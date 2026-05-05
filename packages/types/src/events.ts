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
    };

export type TuttiEventType = TuttiEvent["type"];

export type TuttiEventHandler<T extends TuttiEventType = TuttiEventType> = (
  event: Extract<TuttiEvent, { type: T }>
) => void;
