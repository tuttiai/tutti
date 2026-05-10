import OpenAI from "openai";
import type { APIError } from "openai";
import type {
  LLMProvider,
  ChatRequest,
  ChatResponse,
  ContentBlock,
  StreamChunk,
  StopReason,
} from "@tuttiai/types";
import { SecretsManager } from "../secrets.js";
import { logger } from "../logger.js";
import {
  ProviderError,
  AuthenticationError,
  RateLimitError,
} from "../errors.js";

/**
 * Configuration for {@link OpenRouterProvider}.
 *
 * OpenRouter is an OpenAI-compatible aggregator that routes requests to
 * 300+ models across providers. Model strings are namespaced
 * (`anthropic/...`, `openai/...`, `google/...`, `meta-llama/...`); see
 * <https://openrouter.ai/models> for the live catalogue.
 */
export interface OpenRouterProviderOptions {
  /** API key. Defaults to `OPENROUTER_API_KEY` via `SecretsManager`. */
  api_key?: string;
  /** Base URL override. Defaults to `https://openrouter.ai/api/v1`. */
  base_url?: string;
  /**
   * Site URL sent as `HTTP-Referer`. Used by OpenRouter for the public
   * leaderboard at <https://openrouter.ai/rankings> — opt-in attribution.
   */
  http_referer?: string;
  /**
   * App name sent as `X-Title`. Same opt-in attribution surface as
   * `http_referer`. Both headers are optional.
   */
  x_title?: string;
  /**
   * OpenRouter routing flag. `'fallback'` lets OpenRouter retry the
   * request against a backup provider when the primary fails. Omit for
   * single-provider routing.
   */
  route?: "fallback";
  /**
   * Optional ordered list of model fallbacks. When set, OpenRouter
   * tries each in order if the primary errors out. The active model
   * is reported on the response.
   */
  models?: string[];
}

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/**
 * LLM provider that routes through OpenRouter's OpenAI-compatible API.
 *
 * Differences from {@link OpenAIProvider}:
 * - Default `baseURL` points at OpenRouter.
 * - Sends optional `HTTP-Referer` / `X-Title` attribution headers.
 * - Requests `usage: { include: true }` so OpenRouter returns per-call
 *   USD cost on `usage.cost`. The cost is surfaced on
 *   `ChatResponse.usage.cost_usd` and `StreamChunk.usage.cost_usd` —
 *   no second HTTP round trip required.
 *
 * @example
 * ```ts
 * const provider = new OpenRouterProvider({
 *   http_referer: "https://example.com",
 *   x_title: "My App",
 *   route: "fallback",
 * });
 * const result = await provider.chat({
 *   model: "anthropic/claude-sonnet-4",
 *   messages: [{ role: "user", content: "Hello" }],
 * });
 * console.log(result.usage.cost_usd); // populated by OpenRouter
 * ```
 */
export class OpenRouterProvider implements LLMProvider {
  private client: OpenAI;
  private extras: {
    route?: "fallback";
    models?: string[];
  };

  constructor(options: OpenRouterProviderOptions = {}) {
    const headers: Record<string, string> = {};
    if (options.http_referer) headers["HTTP-Referer"] = options.http_referer;
    if (options.x_title) headers["X-Title"] = options.x_title;

    this.client = new OpenAI({
      apiKey:
        options.api_key ?? SecretsManager.optional("OPENROUTER_API_KEY"),
      baseURL: options.base_url ?? OPENROUTER_BASE_URL,
      ...(Object.keys(headers).length > 0 && { defaultHeaders: headers }),
    });

    this.extras = {
      ...(options.route && { route: options.route }),
      ...(options.models && { models: options.models }),
    };
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    if (!request.model) {
      throw new ProviderError(
        "OpenRouterProvider requires a model on ChatRequest.\n" +
          "Set model on the agent or default_model on the score. " +
          "Model strings are namespaced (e.g. `anthropic/claude-sonnet-4`); " +
          "see https://openrouter.ai/models.",
        { provider: "openrouter" },
      );
    }

    const messages = mapMessages(request);
    const tools = mapTools(request);

    let response;
    try {
      response = await this.client.chat.completions.create(
        // OpenRouter accepts `usage`, `route`, `models` as extra body
        // params on top of the OpenAI-compatible schema. The OpenAI SDK
        // forwards unknown fields, but the parameter type is closed —
        // safe assertion: OpenRouter's chat-completions endpoint
        // documents these fields, and the SDK passes them through.
        {
          model: request.model,
          messages,
          tools: tools && tools.length > 0 ? tools : undefined,
          max_tokens: request.max_tokens,
          temperature: request.temperature,
          stop: request.stop_sequences,
          usage: { include: true },
          ...this.extras,
        } as unknown as OpenAI.ChatCompletionCreateParamsNonStreaming,
      );
    } catch (error) {
      throw mapError(error, "Provider request failed");
    }

    const choice = response.choices[0];
    if (!choice) {
      throw new ProviderError("OpenRouter returned no choices.", {
        provider: "openrouter",
      });
    }

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
          input: parseToolArgs(toolCall.function.arguments),
        });
      }
    }

    const stop_reason = mapFinishReason(choice.finish_reason);
    const usage = response.usage as
      | (OpenAI.CompletionUsage & { cost?: number })
      | undefined;

    return {
      id: response.id,
      content,
      stop_reason,
      usage: {
        input_tokens: usage?.prompt_tokens ?? 0,
        output_tokens: usage?.completion_tokens ?? 0,
        ...(typeof usage?.cost === "number" && { cost_usd: usage.cost }),
      },
    };
  }

  async *stream(request: ChatRequest): AsyncGenerator<StreamChunk> {
    if (!request.model) {
      throw new ProviderError(
        "OpenRouterProvider requires a model on ChatRequest.\n" +
          "Set model on the agent or default_model on the score.",
        { provider: "openrouter" },
      );
    }

    const messages = mapMessages(request);
    const tools = mapTools(request);

    let raw;
    try {
      raw = await this.client.chat.completions.create(
        // Same extra-body justification as `chat()` above. `stream: true`
        // and `stream_options.include_usage` flip the SDK return type to
        // an async iterable of chunks.
        {
          model: request.model,
          messages,
          tools: tools && tools.length > 0 ? tools : undefined,
          max_tokens: request.max_tokens,
          temperature: request.temperature,
          stop: request.stop_sequences,
          stream: true,
          stream_options: { include_usage: true },
          usage: { include: true },
          ...this.extras,
        } as unknown as OpenAI.ChatCompletionCreateParamsStreaming,
      );
    } catch (error) {
      throw mapError(error, "Provider stream failed");
    }

    const toolCalls = new Map<
      number,
      { id: string; name: string; args: string }
    >();
    let finishReason: StopReason = "end_turn";

    for await (const chunk of raw) {
      const choice = chunk.choices[0];

      if (!choice) {
        if (chunk.usage) {
          const usage = chunk.usage as OpenAI.CompletionUsage & {
            cost?: number;
          };
          yield {
            type: "usage",
            usage: {
              input_tokens: usage.prompt_tokens,
              output_tokens: usage.completion_tokens,
              ...(typeof usage.cost === "number" && {
                cost_usd: usage.cost,
              }),
            },
            stop_reason: finishReason,
          };
        }
        continue;
      }

      if (choice.delta.content) {
        yield { type: "text", text: choice.delta.content };
      }

      if (choice.delta.tool_calls) {
        for (const tc of choice.delta.tool_calls) {
          if (tc.id) {
            toolCalls.set(tc.index, {
              id: tc.id,
              name: tc.function?.name ?? "",
              args: "",
            });
          }
          const existing = toolCalls.get(tc.index);
          if (existing && tc.function?.arguments) {
            existing.args += tc.function.arguments;
          }
        }
      }

      if (choice.finish_reason) {
        for (const tc of toolCalls.values()) {
          yield {
            type: "tool_use",
            tool: {
              id: tc.id,
              name: tc.name,
              input: parseToolArgs(tc.args),
            },
          };
        }
        finishReason = mapFinishReason(choice.finish_reason);
      }
    }
  }
}

function mapMessages(
  request: ChatRequest,
): OpenAI.ChatCompletionMessageParam[] {
  const messages: OpenAI.ChatCompletionMessageParam[] = [];

  if (request.system) {
    messages.push({ role: "system", content: request.system });
  }

  for (const msg of request.messages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        messages.push({ role: "user", content: msg.content });
      } else {
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

  return messages;
}

function mapTools(
  request: ChatRequest,
): OpenAI.ChatCompletionTool[] | undefined {
  return request.tools?.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  }));
}

function mapFinishReason(
  reason: string | null | undefined,
): StopReason {
  switch (reason) {
    case "tool_calls":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "stop":
    default:
      return "end_turn";
  }
}

function parseToolArgs(args: string): unknown {
  if (!args) return {};
  try {
    return JSON.parse(args);
  } catch {
    return {};
  }
}

function mapError(error: unknown, logMessage: string): Error {
  const apiError = error as Partial<APIError> & { status?: number };
  const status = apiError.status;
  const msg = error instanceof Error ? error.message : String(error);
  logger.error(
    { error: msg, provider: "openrouter", status },
    logMessage,
  );

  if (status === 401 || /authentication|api key/i.test(msg)) {
    return new AuthenticationError("openrouter");
  }
  if (status === 429) {
    const retryAfterRaw = (apiError.headers as Record<string, string> | undefined)?.[
      "retry-after"
    ];
    const retryAfter = retryAfterRaw ? Number(retryAfterRaw) : undefined;
    return new RateLimitError(
      "openrouter",
      Number.isFinite(retryAfter) ? retryAfter : undefined,
    );
  }
  return new ProviderError(`OpenRouter API error: ${msg}`, {
    provider: "openrouter",
    status,
  });
}
