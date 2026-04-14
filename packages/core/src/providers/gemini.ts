import {
  GoogleGenerativeAI,
  type Content,
  type FunctionDeclaration,
  type Part,
  SchemaType,
} from "@google/generative-ai";
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

export interface GeminiProviderOptions {
  /** Gemini API key. Defaults to GEMINI_API_KEY env var. */
  api_key?: string;
}

export class GeminiProvider implements LLMProvider {
  private client: GoogleGenerativeAI;

  constructor(options: GeminiProviderOptions = {}) {
    const apiKey = options.api_key ?? SecretsManager.optional("GEMINI_API_KEY");
    if (!apiKey) {
      throw new AuthenticationError("gemini");
    }
    this.client = new GoogleGenerativeAI(apiKey);
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const model = request.model ?? "gemini-2.0-flash";

    // Build tool declarations
    const tools: { functionDeclarations: FunctionDeclaration[] }[] = [];
    if (request.tools && request.tools.length > 0) {
      tools.push({
        functionDeclarations: request.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: convertJsonSchemaToGemini(tool.input_schema),
        })),
      });
    }

    const generativeModel = this.client.getGenerativeModel({
      model,
      systemInstruction: request.system,
      tools: tools.length > 0 ? tools : undefined,
    });

    // Map messages to Gemini contents
    const contents: Content[] = [];

    for (const msg of request.messages) {
      if (msg.role === "user") {
        if (typeof msg.content === "string") {
          contents.push({ role: "user", parts: [{ text: msg.content }] });
        } else {
          // Tool results
          const parts: Part[] = [];
          for (const block of msg.content) {
            if (block.type === "tool_result") {
              parts.push({
                functionResponse: {
                  name: block.tool_use_id, // Gemini uses the function name, but we store id
                  response: { content: block.content },
                },
              });
            }
          }
          if (parts.length > 0) {
            contents.push({ role: "user", parts });
          }
        }
      } else if (msg.role === "assistant") {
        if (typeof msg.content === "string") {
          contents.push({ role: "model", parts: [{ text: msg.content }] });
        } else {
          const parts: Part[] = [];
          for (const block of msg.content) {
            if (block.type === "text") {
              parts.push({ text: block.text });
            } else if (block.type === "tool_use") {
              parts.push({
                functionCall: {
                  name: block.name,
                  args: block.input as Record<string, unknown>,
                },
              });
            }
          }
          if (parts.length > 0) {
            contents.push({ role: "model", parts });
          }
        }
      }
    }

    let result;
    try {
      result = await generativeModel.generateContent({
        contents,
        generationConfig: {
          maxOutputTokens: request.max_tokens,
          temperature: request.temperature,
          stopSequences: request.stop_sequences,
        },
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error({ error: msg, provider: "gemini" }, "Provider request failed");
      throw new ProviderError(`Gemini API error: ${msg}`, { provider: "gemini" });
    }

    const response = result.response;
    const candidate = response.candidates?.[0];

    if (!candidate) {
      return {
        id: "",
        content: [{ type: "text", text: "(no response from Gemini)" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 0, output_tokens: 0 },
      };
    }

    // Map response parts to ContentBlocks
    const content: ContentBlock[] = [];
    let hasToolCalls = false;

    for (const part of candidate.content.parts) {
      if ("text" in part && part.text) {
        content.push({ type: "text", text: part.text });
      }
      if ("functionCall" in part && part.functionCall) {
        hasToolCalls = true;
        content.push({
          type: "tool_use",
          id: part.functionCall.name, // Gemini doesn't have call IDs — use name
          name: part.functionCall.name,
          input: part.functionCall.args ?? {},
        });
      }
    }

    const stopReason = hasToolCalls ? "tool_use" : "end_turn";
    const usage = response.usageMetadata;

    return {
      id: "",
      content,
      stop_reason: stopReason,
      usage: {
        input_tokens: usage?.promptTokenCount ?? 0,
        output_tokens: usage?.candidatesTokenCount ?? 0,
      },
    };
  }

  async *stream(request: ChatRequest): AsyncGenerator<StreamChunk> {
    const model = request.model ?? "gemini-2.0-flash";

    const tools: { functionDeclarations: FunctionDeclaration[] }[] = [];
    if (request.tools && request.tools.length > 0) {
      tools.push({
        functionDeclarations: request.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: convertJsonSchemaToGemini(tool.input_schema),
        })),
      });
    }

    const generativeModel = this.client.getGenerativeModel({
      model,
      systemInstruction: request.system,
      tools: tools.length > 0 ? tools : undefined,
    });

    const contents: Content[] = [];
    for (const msg of request.messages) {
      if (msg.role === "user") {
        if (typeof msg.content === "string") {
          contents.push({ role: "user", parts: [{ text: msg.content }] });
        } else {
          const parts: Part[] = [];
          for (const block of msg.content) {
            if (block.type === "tool_result") {
              parts.push({ functionResponse: { name: block.tool_use_id, response: { content: block.content } } });
            }
          }
          if (parts.length > 0) contents.push({ role: "user", parts });
        }
      } else if (msg.role === "assistant") {
        if (typeof msg.content === "string") {
          contents.push({ role: "model", parts: [{ text: msg.content }] });
        } else {
          const parts: Part[] = [];
          for (const block of msg.content) {
            if (block.type === "text") parts.push({ text: block.text });
            else if (block.type === "tool_use") parts.push({ functionCall: { name: block.name, args: block.input as Record<string, unknown> } });
          }
          if (parts.length > 0) contents.push({ role: "model", parts });
        }
      }
    }

    let result;
    try {
      result = await generativeModel.generateContentStream({
        contents,
        generationConfig: {
          maxOutputTokens: request.max_tokens,
          temperature: request.temperature,
          stopSequences: request.stop_sequences,
        },
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error({ error: msg, provider: "gemini" }, "Provider stream failed");
      throw new Error(
        `Gemini API error: ${msg}\n` +
        `Check that GEMINI_API_KEY is set correctly in your .env file.`,
      );
    }

    let hasToolCalls = false;

    for await (const chunk of result.stream) {
      const candidate = chunk.candidates?.[0];
      if (!candidate) continue;
      for (const part of candidate.content.parts) {
        if ("text" in part && part.text) {
          yield { type: "text", text: part.text };
        }
        if ("functionCall" in part && part.functionCall) {
          hasToolCalls = true;
          yield {
            type: "tool_use",
            tool: { id: part.functionCall.name, name: part.functionCall.name, input: part.functionCall.args ?? {} },
          };
        }
      }
    }

    const response = await result.response;
    const usage = response.usageMetadata;
    yield {
      type: "usage",
      usage: { input_tokens: usage?.promptTokenCount ?? 0, output_tokens: usage?.candidatesTokenCount ?? 0 },
      stop_reason: hasToolCalls ? "tool_use" : "end_turn",
    };
  }
}

/**
 * Convert a JSON Schema object into a shape Gemini's API accepts.
 * Gemini uses its own SchemaType enum for type values.
 */
function convertJsonSchemaToGemini(
  schema: Record<string, unknown>,
): FunctionDeclaration["parameters"] {
  const type = schema.type as string;
  const schemaTypeMap = new Map<string, SchemaType>([
    ["STRING", SchemaType.STRING],
    ["NUMBER", SchemaType.NUMBER],
    ["INTEGER", SchemaType.INTEGER],
    ["BOOLEAN", SchemaType.BOOLEAN],
    ["ARRAY", SchemaType.ARRAY],
    ["OBJECT", SchemaType.OBJECT],
  ]);

  return {
    type: schemaTypeMap.get(type?.toUpperCase() ?? "") ?? SchemaType.OBJECT,
    properties: schema.properties as Record<string, unknown> | undefined,
    required: schema.required as string[] | undefined,
    description: schema.description as string | undefined,
  } as FunctionDeclaration["parameters"];
}
