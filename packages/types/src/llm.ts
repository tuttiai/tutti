/** Model-agnostic LLM provider interface. */

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export interface ChatMessage {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ChatRequest {
  model?: string;
  messages: ChatMessage[];
  system?: string;
  tools?: ToolDefinition[];
  max_tokens?: number;
  temperature?: number;
  stop_sequences?: string[];
  /**
   * Cancels the call when aborted. The agent runner sets it from
   * `AgentRunOptions.signal` so a run whose caller has gone away stops
   * waiting on the model. A provider that can cancel its request (an SDK's
   * request options, a child process) should; one that cannot may ignore
   * it, and the runner still stops at its next step.
   */
  signal?: AbortSignal;
}

export interface ChatResponse {
  id: string;
  content: ContentBlock[];
  stop_reason: StopReason;
  usage: TokenUsage;
}

export interface TokenUsage {
  /**
   * Every prompt token the call consumed, cached or not. The two cache
   * fields below are parts of this figure, never additions to it, so a
   * caller that ignores them still sees the whole prompt.
   */
  input_tokens: number;
  output_tokens: number;
  /**
   * Prompt tokens served from the provider's prompt cache, a subset of
   * `input_tokens`. Billed well below the normal input rate. Absent when the
   * provider does not report it.
   */
  cache_read_input_tokens?: number;
  /**
   * Prompt tokens written to the provider's prompt cache, a subset of
   * `input_tokens`. Billed above the normal input rate, and repaid by every
   * later read. Absent when the provider does not report it.
   */
  cache_creation_input_tokens?: number;
  /**
   * Estimated USD cost for these tokens. Populated by `@tuttiai/telemetry`
   * on `AgentResult.usage` when the run's model is in the price table.
   * Left unset on per-call `ChatResponse.usage` (LLM providers don't
   * return cost).
   */
  cost_usd?: number;
}

export interface StreamChunk {
  type: "text" | "tool_use" | "usage";
  text?: string;
  tool?: Omit<ToolUseBlock, "type">;
  usage?: TokenUsage;
  stop_reason?: StopReason;
}

export interface LLMProvider {
  chat(request: ChatRequest): Promise<ChatResponse>;
  stream(request: ChatRequest): AsyncIterable<StreamChunk>;
}
