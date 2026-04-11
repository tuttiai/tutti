import OpenAI from "openai";
import type {
  LLMProvider,
  ChatRequest,
  ChatResponse,
  ContentBlock,
} from "@tuttiai/types";
import { SecretsManager } from "../secrets.js";

export interface OpenAIProviderOptions {
  /** OpenAI API key. Defaults to OPENAI_API_KEY env var. */
  api_key?: string;
  /** Custom base URL for Azure, proxies, or compatible APIs. */
  base_url?: string;
}

export class OpenAIProvider implements LLMProvider {
  private client: OpenAI;

  constructor(options: OpenAIProviderOptions = {}) {
    this.client = new OpenAI({
      apiKey: options.api_key ?? SecretsManager.optional("OPENAI_API_KEY"),
      baseURL: options.base_url,
    });
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    if (!request.model) {
      throw new Error(
        "OpenAIProvider requires a model on ChatRequest.\n" +
        "Set model on the agent or default_model on the score.",
      );
    }

    // Map messages to OpenAI format
    const messages: OpenAI.ChatCompletionMessageParam[] = [];

    if (request.system) {
      messages.push({ role: "system", content: request.system });
    }

    for (const msg of request.messages) {
      if (msg.role === "user") {
        if (typeof msg.content === "string") {
          messages.push({ role: "user", content: msg.content });
        } else {
          // Tool results → map to OpenAI tool message format
          for (const block of msg.content) {
            if (block.type === "tool_result") {
              messages.push({
                role: "tool",
                tool_call_id: block.tool_use_id,
                content: block.content,
              });
            }
          }
        }
      } else if (msg.role === "assistant") {
        if (typeof msg.content === "string") {
          messages.push({ role: "assistant", content: msg.content });
        } else {
          // May contain text and/or tool_use blocks
          const textParts = msg.content
            .filter((b) => b.type === "text")
            .map((b) => (b as { text: string }).text)
            .join("\n");

          const toolCalls = msg.content
            .filter((b) => b.type === "tool_use")
            .map((b) => {
              const block = b as { id: string; name: string; input: unknown };
              return {
                id: block.id,
                type: "function" as const,
                function: {
                  name: block.name,
                  arguments: JSON.stringify(block.input),
                },
              };
            });

          messages.push({
            role: "assistant",
            content: textParts || null,
            ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
          });
        }
      }
    }

    // Map tools to OpenAI function format
    const tools: OpenAI.ChatCompletionTool[] | undefined = request.tools?.map(
      (tool) => ({
        type: "function" as const,
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.input_schema as Record<string, unknown>,
        },
      }),
    );

    let response;
    try {
      response = await this.client.chat.completions.create({
        model: request.model,
        messages,
        tools: tools && tools.length > 0 ? tools : undefined,
        max_tokens: request.max_tokens,
        temperature: request.temperature,
        stop: request.stop_sequences,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(
        `OpenAI API error: ${msg}\n` +
        `Check that OPENAI_API_KEY is set correctly in your .env file.`,
      );
    }

    const choice = response.choices[0];
    const content: ContentBlock[] = [];

    if (choice.message.content) {
      content.push({ type: "text", text: choice.message.content });
    }

    if (choice.message.tool_calls) {
      for (const toolCall of choice.message.tool_calls) {
        content.push({
          type: "tool_use",
          id: toolCall.id,
          name: toolCall.function.name,
          input: JSON.parse(toolCall.function.arguments),
        });
      }
    }

    // Map stop reason
    let stopReason: ChatResponse["stop_reason"];
    switch (choice.finish_reason) {
      case "stop":
        stopReason = "end_turn";
        break;
      case "tool_calls":
        stopReason = "tool_use";
        break;
      case "length":
        stopReason = "max_tokens";
        break;
      default:
        stopReason = "end_turn";
    }

    return {
      id: response.id,
      content,
      stop_reason: stopReason,
      usage: {
        input_tokens: response.usage?.prompt_tokens ?? 0,
        output_tokens: response.usage?.completion_tokens ?? 0,
      },
    };
  }
}
