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

export interface ToolContext {
  session_id: string;
  agent_name: string;
  /** Semantic memory helpers — only available when agent.semantic_memory.enabled is true. */
  memory?: ToolMemoryHelpers;
}

export interface Tool<T = unknown> {
  name: string;
  description: string;
  parameters: ZodType<T, any, any>;
  execute(input: T, context: ToolContext): Promise<ToolResult>;
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
