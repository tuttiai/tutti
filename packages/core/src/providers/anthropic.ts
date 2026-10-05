import Anthropic from "@anthropic-ai/sdk";
import type {
  LLMProvider,
  ChatRequest,
  ChatResponse,
  ContentBlock,
  StreamChunk,
} from "@tuttiai/types";
import { SecretsManager } from "../secrets.js";
import { logger } from "../logger.js";
import { ProviderError, AuthenticationError } from "../errors.js";
import { buildAnthropicPrompt, toTokenUsage } from "./anthropic-request.js";
import type { AnthropicUsage } from "./anthropic-request.js";

export interface AnthropicProviderOptions {
  api_key?: string;
}

export class AnthropicProvider implements LLMProvider {
  private client: Anthropic;

  constructor(options: AnthropicProviderOptions = {}) {
    this.client = new Anthropic({
      apiKey: options.api_key ?? SecretsManager.optional("ANTHROPIC_API_KEY"),
    });
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    if (!request.model) {
      throw new ProviderError(
        "AnthropicProvider requires a model on ChatRequest.\n" +
        "Set model on the agent or default_model on the score.",
        { provider: "anthropic" },
      );
    }

    let response;
    try {
      response = await this.client.messages.create({
        model: request.model,
        max_tokens: request.max_tokens ?? 4096,
        ...buildAnthropicPrompt(request),
        ...(request.temperature != null && { temperature: request.temperature }),
        ...(request.stop_sequences && { stop_sequences: request.stop_sequences }),
      }, requestOptions(request));
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error({ error: msg, provider: "anthropic" }, "Provider request failed");
      if (msg.includes("authentication") || msg.includes("apiKey") || msg.includes("authToken")) {
        throw new AuthenticationError("anthropic");
      }
      throw new ProviderError(`Anthropic API error: ${msg}`, { provider: "anthropic" });
    }

    const content: ContentBlock[] = response.content.map((block) => {
      if (block.type === "text") {
        return { type: "text" as const, text: block.text };
      }
      if (block.type === "tool_use") {
        return {
          type: "tool_use" as const,
          id: block.id,
          name: block.name,
          input: block.input,
        };
      }
      throw new Error(`Unexpected content block type: ${(block as { type: string }).type}`);
    });

    return {
      id: response.id,
      content,
      stop_reason: response.stop_reason as ChatResponse["stop_reason"],
      usage: toTokenUsage(response.usage),
    };
  }

  async *stream(request: ChatRequest): AsyncGenerator<StreamChunk> {
    if (!request.model) {
      throw new ProviderError(
        "AnthropicProvider requires a model on ChatRequest.\n" +
        "Set model on the agent or default_model on the score.",
        { provider: "anthropic" },
      );
    }

    let raw;
    try {
      raw = await this.client.messages.create({
        model: request.model,
        max_tokens: request.max_tokens ?? 4096,
        ...buildAnthropicPrompt(request),
        ...(request.temperature != null && { temperature: request.temperature }),
        ...(request.stop_sequences && { stop_sequences: request.stop_sequences }),
        stream: true,
      }, requestOptions(request));
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error({ error: msg, provider: "anthropic" }, "Provider stream failed");
      if (msg.includes("authentication") || msg.includes("apiKey") || msg.includes("authToken")) {
        throw new AuthenticationError("anthropic");
      }
      throw new ProviderError(`Anthropic API error: ${msg}`, { provider: "anthropic" });
    }

    // Track tool_use blocks being streamed (input arrives as partial JSON)
    const toolBlocks = new Map<number, { id: string; name: string; json: string }>();
    let startUsage: AnthropicUsage = { input_tokens: 0, output_tokens: 0 };
    let outputTokens = 0;
    let stopReason: string = "end_turn";

    for await (const event of raw) {
      if (event.type === "message_start") {
        startUsage = event.message.usage;
      }
      if (event.type === "content_block_start") {
        if (event.content_block.type === "tool_use") {
          toolBlocks.set(event.index, {
            id: event.content_block.id,
            name: event.content_block.name,
            json: "",
          });
        }
      }
      if (event.type === "content_block_delta") {
        if (event.delta.type === "text_delta") {
          yield { type: "text", text: event.delta.text };
        }
        if (event.delta.type === "input_json_delta") {
          const block = toolBlocks.get(event.index);
          if (block) block.json += event.delta.partial_json;
        }
      }
      if (event.type === "content_block_stop") {
        const block = toolBlocks.get(event.index);
        if (block) {
          yield {
            type: "tool_use",
            tool: {
              id: block.id,
              name: block.name,
              input: block.json ? JSON.parse(block.json) : {},
            },
          };
          toolBlocks.delete(event.index);
        }
      }
      if (event.type === "message_delta") {
        outputTokens = event.usage.output_tokens;
        stopReason = event.delta.stop_reason ?? "end_turn";
      }
    }

    yield {
      type: "usage",
      usage: toTokenUsage({ ...startUsage, output_tokens: outputTokens }),
      stop_reason: stopReason as StreamChunk["stop_reason"],
    };
  }
}

/** The SDK's per-request options: the run's signal, so an abort cancels the HTTP call. */
function requestOptions(request: ChatRequest): { signal: AbortSignal } | undefined {
  return request.signal ? { signal: request.signal } : undefined;
}
