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
  | { type: "budget:warning"; agent_name: string; tokens: number; cost_usd: number }
  | { type: "budget:exceeded"; agent_name: string; tokens: number; cost_usd: number }
  | { type: "token:stream"; agent_name: string; text: string }
  | { type: "hitl:requested"; agent_name: string; session_id: string; question: string; options?: string[] }
  | { type: "hitl:answered"; agent_name: string; session_id: string; answer: string }
  | { type: "hitl:timeout"; agent_name: string; session_id: string }
  | { type: "checkpoint:saved"; session_id: string; turn: number }
  | { type: "checkpoint:restored"; session_id: string; turn: number }
  | { type: "schedule:triggered"; schedule_id: string; agent_name: string }
  | { type: "schedule:completed"; schedule_id: string; agent_name: string; duration_ms: number }
  | { type: "schedule:error"; schedule_id: string; agent_name: string; error: Error };

export type TuttiEventType = TuttiEvent["type"];

export type TuttiEventHandler<T extends TuttiEventType = TuttiEventType> = (
  event: Extract<TuttiEvent, { type: T }>
) => void;
