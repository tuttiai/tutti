import type { ToolResult } from "@tuttiai/types";
import type { WhatsAppClient } from "../index.js";

/**
 * Gate helper shared by every tool. Returns a ready-to-hand-back
 * ToolResult if the client is unusable, or `null` to continue.
 */
export function guardClient(client: WhatsAppClient): ToolResult | null {
  if (client.kind === "missing") {
    return { content: client.message, is_error: true };
  }
  return null;
}
