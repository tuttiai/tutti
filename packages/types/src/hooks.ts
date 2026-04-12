/** Lifecycle hooks for agent runs, LLM calls, and tool executions. */

import type { ChatRequest, ChatResponse } from "./llm.js";
import type { ToolResult } from "./voice.js";
import type { AgentResult } from "./agent.js";

/** Context passed to every hook invocation. */
export interface HookContext {
  agent_name: string;
  session_id: string;
  turn: number;
  metadata: Record<string, unknown>;
}

/**
 * Lifecycle hooks for customizing agent behavior.
 *
 * Set on `ScoreConfig.hooks` (global) or `AgentConfig.hooks` (per-agent).
 * Agent-level hooks merge with global hooks — both fire, agent-level first.
 *
 * Hook errors are caught and logged — they never crash the agent.
 */
export interface TuttiHooks {
  /** Called before each LLM call. Return a modified request to alter it. */
  beforeLLMCall?: (ctx: HookContext, request: ChatRequest) => Promise<ChatRequest>;
  /** Called after each LLM response. */
  afterLLMCall?: (ctx: HookContext, response: ChatResponse) => Promise<void>;
  /** Called before each tool execution. Return false to block the call. Return anything else to proceed. */
  beforeToolCall?: (ctx: HookContext, tool: string, input: unknown) => Promise<unknown>;
  /** Called after each tool execution. Return a modified result. */
  afterToolCall?: (ctx: HookContext, tool: string, result: ToolResult) => Promise<ToolResult>;
  /** Called when an agent run starts (before the first turn). */
  beforeAgentRun?: (ctx: HookContext) => Promise<void>;
  /** Called when an agent run finishes (after the last turn). */
  afterAgentRun?: (ctx: HookContext, result: AgentResult) => Promise<void>;
}
