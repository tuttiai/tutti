import { randomUUID } from "node:crypto";

import { z } from "zod";
import type { ChatRequest, ContentBlock, ToolDefinition } from "@tuttiai/types";

/*
 * Claude Code runs its own agent loop and owns its own tools, so it cannot be
 * handed Tutti's tools as native ones. Instead every built-in tool is switched
 * off and the model answers through structured output: it either gives the
 * final text or asks the host to run some of Tutti's tools. Tutti's runner
 * then executes those exactly as it would for any other provider.
 */

const TOOL_PROTOCOL = `# How to reply
Every reply is one call to your StructuredOutput tool. That is the only tool you can call directly.

The host tools listed in the prompt are NOT callable by you. To use one, add a request for it to the "tool_calls" array of your StructuredOutput call and leave "text" empty. The host runs it and sends you the result in the next turn, as a "tool_result" block. When you have the final answer, put it in "text" and leave "tool_calls" empty.`;

const TEXT_PROTOCOL = `# How to reply
Every reply is one call to your StructuredOutput tool, with your answer in "text".`;

/**
 * The system prompt for one call: the agent's own prompt, then the reply
 * protocol.
 *
 * @param request - The chat request being served.
 * @returns The text passed as `--system-prompt`.
 */
export function buildSystemPrompt(request: ChatRequest): string {
  const protocol = hasTools(request) ? TOOL_PROTOCOL : TEXT_PROTOCOL;
  const own = request.system?.trim();
  return own ? `${own}\n\n${protocol}` : protocol;
}

/**
 * The prompt written to stdin: the host tools, then the whole conversation.
 * Each call is stateless, so the transcript carries all prior turns. JSON
 * keeps message boundaries unambiguous whatever the messages contain.
 *
 * @param request - The chat request being served.
 * @returns The text written to the CLI's stdin.
 */
export function buildPrompt(request: ChatRequest): string {
  const parts: string[] = [];
  if (hasTools(request)) {
    const tools = (request.tools ?? []).map(describeTool);
    parts.push(`# Host tools\n${JSON.stringify(tools, null, 2)}`);
  }
  parts.push(
    "# Conversation\n" +
      'The conversation so far, oldest first. "tool_use" blocks are host tool calls you made; ' +
      '"tool_result" blocks are what the host returned. Reply to the latest message as the assistant.\n\n' +
      JSON.stringify(request.messages, null, 2),
  );
  return parts.join("\n\n");
}

/**
 * JSON Schema for the model's structured reply, passed as `--json-schema`.
 * Tool names are an enum, so the model cannot request a tool that does not
 * exist.
 *
 * @param request - The chat request being served.
 * @returns The schema, serialised.
 */
export function buildReplySchema(request: ChatRequest): string {
  const names = (request.tools ?? []).map((tool) => tool.name);
  const properties: Record<string, unknown> = { text: { type: "string" } };
  if (names.length > 0) {
    properties["tool_calls"] = {
      type: "array",
      items: {
        type: "object",
        properties: { name: { type: "string", enum: names }, input: { type: "object" } },
        required: ["name", "input"],
      },
    };
  }
  return JSON.stringify({
    type: "object",
    properties,
    required: Object.keys(properties),
  });
}

/** The fields Tutti reads from the CLI's `--output-format json` result. */
export const ClaudeCodeResultSchema = z.object({
  is_error: z.boolean(),
  result: z.string().optional(),
  api_error_status: z.number().nullable().optional(),
  session_id: z.string().optional(),
  structured_output: z.unknown().optional(),
  usage: z
    .object({
      input_tokens: z.number().default(0),
      output_tokens: z.number().default(0),
      cache_read_input_tokens: z.number().default(0),
      cache_creation_input_tokens: z.number().default(0),
    })
    .optional(),
});

/** The CLI's result, validated. */
export type ClaudeCodeResult = z.infer<typeof ClaudeCodeResultSchema>;

const ReplySchema = z.object({
  text: z.string().default(""),
  tool_calls: z
    .array(z.object({ name: z.string(), input: z.record(z.unknown()).default({}) }))
    .default([]),
});

/**
 * Turns the model's structured reply into Tutti content blocks. Tool call ids
 * are minted here rather than taken from the model, so they are always unique.
 *
 * @param structured - The `structured_output` field of the CLI result.
 * @param tools - The tools offered on this call.
 * @returns The content blocks, or `undefined` when the reply is malformed.
 */
export function parseReply(
  structured: unknown,
  tools: ToolDefinition[] | undefined,
): ContentBlock[] | undefined {
  const parsed = ReplySchema.safeParse(structured);
  if (!parsed.success) return undefined;
  const offered = new Set((tools ?? []).map((tool) => tool.name));
  const blocks: ContentBlock[] = [];
  const text = parsed.data.text.trim();
  if (text) blocks.push({ type: "text", text });
  for (const call of parsed.data.tool_calls) {
    if (!offered.has(call.name)) return undefined;
    blocks.push({ type: "tool_use", id: `toolu_cc_${randomUUID()}`, name: call.name, input: call.input });
  }
  return blocks;
}

function hasTools(request: ChatRequest): boolean {
  return (request.tools?.length ?? 0) > 0;
}

function describeTool(tool: ToolDefinition): Record<string, unknown> {
  return { name: tool.name, description: tool.description, input_schema: tool.input_schema };
}
