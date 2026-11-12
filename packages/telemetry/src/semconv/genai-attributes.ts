/**
 * Attribute keys from the OpenTelemetry GenAI semantic conventions that
 * {@link genAiSpanNaming} emits. The keys were checked against semantic
 * conventions 1.43.0, where the GenAI conventions are still in
 * Development (experimental) status and may change upstream. Tutti treats
 * these keys as stable: later features (time to first token, for example)
 * import them from here.
 *
 * `error.type` is a general (stable) semantic-convention attribute that
 * GenAI spans use for failures.
 *
 * @see https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/
 */
export const GEN_AI_ATTRIBUTES = {
  /** Operation the span represents, one of {@link GEN_AI_OPERATIONS}. */
  OPERATION_NAME: "gen_ai.operation.name",
  /** Human-readable agent name; Tutti uses the agent id from the score. */
  AGENT_NAME: "gen_ai.agent.name",
  /** Conversation (session) the span belongs to. */
  CONVERSATION_ID: "gen_ai.conversation.id",
  /** Model the request asked for. */
  REQUEST_MODEL: "gen_ai.request.model",
  /** Input (prompt) tokens, including tokens read from or written to a cache. */
  USAGE_INPUT_TOKENS: "gen_ai.usage.input_tokens",
  /** Output (completion) tokens. */
  USAGE_OUTPUT_TOKENS: "gen_ai.usage.output_tokens",
  /** Input tokens served from the provider's prompt cache. */
  USAGE_CACHE_READ_INPUT_TOKENS: "gen_ai.usage.cache_read.input_tokens",
  /** Input tokens written to the provider's prompt cache. */
  USAGE_CACHE_CREATION_INPUT_TOKENS: "gen_ai.usage.cache_creation.input_tokens",
  /** Name of the tool the span executed. */
  TOOL_NAME: "gen_ai.tool.name",
  /** Class of error a failed span ended with. */
  ERROR_TYPE: "error.type",
} as const;

/**
 * Values of `gen_ai.operation.name` that {@link genAiSpanNaming} emits, and
 * the first word of the matching span name (`"chat claude-sonnet-4-5"`).
 * Checked against OpenTelemetry semantic conventions 1.43.0 (GenAI,
 * Development status).
 */
export const GEN_AI_OPERATIONS = {
  /** An agent run: span name `invoke_agent {agent}`. */
  INVOKE_AGENT: "invoke_agent",
  /** One model call: span name `chat {model}`. */
  CHAT: "chat",
  /** One tool call: span name `execute_tool {tool}`. */
  EXECUTE_TOOL: "execute_tool",
} as const;

/** `error.type` value when the span does not carry a more specific error class. */
export const ERROR_TYPE_OTHER = "_OTHER";
