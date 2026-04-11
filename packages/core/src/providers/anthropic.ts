import Anthropic from "@anthropic-ai/sdk";
import type {
  LLMProvider,
  ChatRequest,
  ChatResponse,
  ContentBlock,
} from "@tuttiai/types";
import { SecretsManager } from "../secrets.js";

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
}
