/** Voice — a pluggable module that gives agents tools and capabilities. */

import type { ZodType } from "zod";

export interface ToolResult {
  content: string;
  is_error?: boolean;
}

export interface ToolContext {
  session_id: string;
  agent_name: string;
}

export interface Tool<T = unknown> {
  name: string;
  description: string;
  parameters: ZodType<T>;
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
  setup?(context: VoiceContext): Promise<void>;
  teardown?(): Promise<void>;
}
