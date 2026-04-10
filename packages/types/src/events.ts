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
  | { type: "turn:end"; agent_name: string; session_id: string; turn: number };

export type TuttiEventType = TuttiEvent["type"];

export type TuttiEventHandler<T extends TuttiEventType = TuttiEventType> = (
  event: Extract<TuttiEvent, { type: T }>
) => void;
