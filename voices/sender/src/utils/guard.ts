import type { ToolResult } from "@tuttiai/types";
import type { SenderClient, SenderClientWrapper } from "../client.js";

/**
 * Gate helper shared by every tool. Returns the usable wrapper, or a
 * ready-to-hand-back error result when the voice is not configured.
 */
export function requireClient(
  client: SenderClient,
): { wrapper: SenderClientWrapper } | { blocked: ToolResult } {
  if (client.kind === "missing") {
    return { blocked: { content: client.message, is_error: true } };
  }
  return { wrapper: client.wrapper };
}

/**
 * Run a tool body against a ready client. Never throws: a missing client or
 * an unexpected exception becomes an `is_error` result.
 */
export async function withClient(
  client: SenderClient,
  label: string,
  body: (wrapper: SenderClientWrapper) => Promise<ToolResult>,
): Promise<ToolResult> {
  const gate = requireClient(client);
  if ("blocked" in gate) return gate.blocked;
  try {
    return await body(gate.wrapper);
  } catch {
    return { content: `Sender ${label} failed unexpectedly.`, is_error: true };
  }
}
