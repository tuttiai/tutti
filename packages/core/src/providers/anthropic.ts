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
      throw new Error(
        "AnthropicProvider requires a model on ChatRequest.\n" +
        "Set model on the agent or default_model on the score.",
      );
    }

    let response;
    try {
      response = await this.client.messages.create({
        model: request.model,
        max_tokens: request.max_tokens ?? 4096,
        system: request.system ?? "",
        messages: request.messages.map((msg) => ({
          role: msg.role,
          content: msg.content as Anthropic.MessageCreateParams["messages"][number]["content"],
        })),
        tools: request.tools?.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.input_schema as Anthropic.Tool["input_schema"],
        })),
        ...(request.temperature != null && { temperature: request.temperature }),
        ...(request.stop_sequences && { stop_sequences: request.stop_sequences }),
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error({ error: msg, provider: "anthropic" }, "Provider request failed");
      throw new Error(
        `Anthropic API error: ${msg}\n` +
        `Check that ANTHROPIC_API_KEY is set correctly in your .env file.`,
      );
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
      usage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
      },
    };
  }

  async *stream(request: ChatRequest): AsyncGenerator<StreamChunk> {
    if (!request.model) {
      throw new Error(
        "AnthropicProvider requires a model on ChatRequest.\n" +
        "Set model on the agent or default_model on the score.",
      );
    }

    let raw;
    try {
      raw = await this.client.messages.create({
        model: request.model,
        max_tokens: request.max_tokens ?? 4096,
        system: request.system ?? "",
        messages: request.messages.map((msg) => ({
          role: msg.role,
          content: msg.content as Anthropic.MessageCreateParams["messages"][number]["content"],
        })),
        tools: request.tools?.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.input_schema as Anthropic.Tool["input_schema"],
        })),
        ...(request.temperature != null && { temperature: request.temperature }),
        ...(request.stop_sequences && { stop_sequences: request.stop_sequences }),
        stream: true,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error({ error: msg, provider: "anthropic" }, "Provider stream failed");
      throw new Error(
        `Anthropic API error: ${msg}\n` +
        `Check that ANTHROPIC_API_KEY is set correctly in your .env file.`,
      );
    }

    // Track tool_use blocks being streamed (input arrives as partial JSON)
    const toolBlocks = new Map<number, { id: string; name: string; json: string }>();
    let inputTokens = 0;
    let outputTokens = 0;
    let stopReason: string = "end_turn";

    for await (const event of raw) {
      if (event.type === "message_start") {
        inputTokens = event.message.usage.input_tokens;
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
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      stop_reason: stopReason as StreamChunk["stop_reason"],
    };
  }
}
