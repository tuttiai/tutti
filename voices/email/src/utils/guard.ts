import type { ToolResult } from "@tuttiai/types";
import type { EmailClient } from "../index.js";

/**
 * Gate helper shared by every tool. Returns a ready-to-hand-back
 * ToolResult if the client is unusable, or `null` to continue.
 */
export function guardClient(client: EmailClient): ToolResult | null {
  if (client.kind === "missing") {
    return { content: client.message, is_error: true };
  }
  return null;
}
