/**
 * Function-call wire-format helpers for `@tuttiai/realtime`.
 *
 * The OpenAI Realtime API streams function calls via three event types:
 *
 * - `response.function_call_arguments.delta` — incremental JSON args
 * - `response.function_call_arguments.done`  — full args, ready to invoke
 * - `conversation.item.create` (function_call_output) — the tool result we
 *   send back so the model can continue the response.
 *
 * This module owns the conversion between Tutti's `Tool` shape and the
 * Realtime API's function-definition shape, plus parsing of the inbound
 * `*.done` event into a {@link RealtimeFunctionCall}.
 */

import { zodToJsonSchema } from "zod-to-json-schema";

import type { Tool } from "@tuttiai/types";

import type { RealtimeEvent } from "./types.js";

/**
 * Concrete function call extracted from a
 * `response.function_call_arguments.done` server event.
 */
export interface RealtimeFunctionCall {
  /** Server-assigned id used to correlate the tool result. */
  call_id: string;
  /** Name of the tool the model wants to invoke. */
  name: string;
  /** Parsed JSON arguments. `null` when arguments are missing or malformed. */
  arguments: unknown;
}

/**
 * Convert a Tutti {@link Tool} to the Realtime API's function-definition
 * shape. The Zod parameters schema is rendered as OpenAPI-3 JSON Schema
 * — matching the Anthropic / OpenAI tool-definition pipeline already in
 * `@tuttiai/core`.
 */
export function toolToFunctionDefinition(tool: Tool): RealtimeEvent {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- Zod generic variance, mirrors agent-runner.ts.
  const parameters = zodToJsonSchema(tool.parameters, { target: "openApi3" });
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters,
  };
}

/**
 * Build the `session.update` event that registers a tool list with the
 * server. Sent once on connect (and again any time the toolset changes).
 */
export function buildToolsSessionUpdate(tools: readonly Tool[]): RealtimeEvent {
  return {
    type: "session.update",
    session: { tools: tools.map(toolToFunctionDefinition) },
  };
}

/**
 * Parse a `response.function_call_arguments.done` event payload. Returns
 * `null` for any other event or for payloads missing the required
 * `call_id`/`name` discriminators so callers can drop malformed frames.
 */
export function parseFunctionCallDone(event: RealtimeEvent): RealtimeFunctionCall | null {
  if (event.type !== "response.function_call_arguments.done") return null;
  const call_id = event["call_id"];
  const name = event["name"];
  if (typeof call_id !== "string" || typeof name !== "string") return null;
  const rawArgs = event["arguments"];
  return { call_id, name, arguments: parseArgsString(rawArgs) };
}

/**
 * Build the `conversation.item.create` event carrying a tool's result
 * back to the server. The Realtime API expects the output as a single
 * stringified payload; we let the caller decide stringification so
 * `is_error: true` results can carry a redacted error string.
 */
export function buildFunctionCallOutput(
  call_id: string,
  output: string,
): RealtimeEvent {
  return {
    type: "conversation.item.create",
    item: {
      type: "function_call_output",
      call_id,
      output,
    },
  };
}

/**
 * Build the `response.create` event that asks the server to continue
 * generating after a tool result has been delivered.
 */
export function buildResponseCreate(): RealtimeEvent {
  return { type: "response.create" };
}

function parseArgsString(raw: unknown): unknown {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
