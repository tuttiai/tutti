import type Anthropic from "@anthropic-ai/sdk";
import type { ChatMessage, ChatRequest, TokenUsage } from "@tuttiai/types";

/*
 * Prompt caching. Anthropic caches a request's prefix up to each block that
 * carries `cache_control`, and a later request whose prefix matches reads it
 * back at a tenth of the input rate. An agent loop re-sends the whole
 * conversation every turn, so without a marker every turn pays full price for
 * everything before it.
 *
 * Two markers are set, of the four the API allows:
 * - the end of the stable part: the system prompt, or the last tool when there
 *   is no system prompt (tools precede the system prompt in the cache order);
 * - the end of the last message, so the next turn reads the whole
 *   conversation so far and pays only for what it adds.
 *
 * A prefix shorter than the model's minimum is not cached, and the API ignores
 * the marker rather than failing, so short prompts cost nothing extra.
 */

const EPHEMERAL = { type: "ephemeral" } as const;

/** The parts of a Messages API request that carry the prompt. */
export interface AnthropicPrompt {
  system: string | Anthropic.TextBlockParam[];
  messages: Anthropic.MessageParam[];
  tools?: Anthropic.Tool[];
}

/**
 * Build the prompt half of a Messages API request, with cache breakpoints.
 *
 * @param request - The chat request being served.
 * @returns The system prompt, messages and tools, marked for caching.
 */
export function buildAnthropicPrompt(request: ChatRequest): AnthropicPrompt {
  const system = request.system ?? "";
  const tools: Anthropic.Tool[] | undefined = request.tools?.map((tool) => ({
    name: tool.name,
    description: tool.description,
    // The SDK types input_schema as a narrower JSON Schema shape; ours is the same object, untyped.
    input_schema: tool.input_schema as Anthropic.Tool["input_schema"],
  }));
  const last = tools?.at(-1);
  if (system === "" && last) tools?.splice(-1, 1, { ...last, cache_control: EPHEMERAL });
  const messages = request.messages.map((msg, i) =>
    i === request.messages.length - 1 ? markLast(msg) : { role: msg.role, content: msg.content },
  );
  return {
    system: system === "" ? "" : [{ type: "text", text: system, cache_control: EPHEMERAL }],
    messages,
    ...(tools !== undefined && { tools }),
  };
}

/** The message with a cache marker on its final block. An empty string has no block to mark. */
function markLast(msg: ChatMessage): Anthropic.MessageParam {
  if (typeof msg.content === "string") {
    if (msg.content === "") return { role: msg.role, content: msg.content };
    return { role: msg.role, content: [{ type: "text", text: msg.content, cache_control: EPHEMERAL }] };
  }
  const blocks = msg.content.map((block, i) =>
    i === msg.content.length - 1 ? { ...block, cache_control: EPHEMERAL } : block,
  );
  return { role: msg.role, content: blocks };
}

/** The usage figures the Messages API reports, in either a response or a `message_start` event. */
export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

/**
 * Convert the API's usage to Tutti's. The API counts cached tokens apart from
 * `input_tokens`; Tutti's `input_tokens` is the whole prompt, with the cache
 * figures as parts of it.
 *
 * @param usage - The usage block from the API.
 * @returns Tutti's token usage.
 */
export function toTokenUsage(usage: AnthropicUsage): TokenUsage {
  const read = usage.cache_read_input_tokens ?? undefined;
  const written = usage.cache_creation_input_tokens ?? undefined;
  return {
    input_tokens: usage.input_tokens + (read ?? 0) + (written ?? 0),
    output_tokens: usage.output_tokens,
    ...(read !== undefined && { cache_read_input_tokens: read }),
    ...(written !== undefined && { cache_creation_input_tokens: written }),
  };
}
