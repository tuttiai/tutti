import type { ToolResult } from "@tuttiai/types";
import type { TwitterClient } from "../client.js";

/**
 * Gate helper shared by every tool. Returns a ready-to-hand-back
 * ToolResult if the client is unusable for the requested operation,
 * or `null` to signal "continue".
 */
export function guardClient(
  client: TwitterClient,
  options: { need_write: boolean },
): ToolResult | null {
  if (client.kind === "missing") {
    return { content: client.message, is_error: true };
  }
  if (options.need_write && !client.can_write) {
    return {
      content:
        "This tool performs a write operation and requires OAuth 1.0a credentials. Set TWITTER_API_KEY + TWITTER_API_SECRET + TWITTER_ACCESS_TOKEN + TWITTER_ACCESS_TOKEN_SECRET.",
      is_error: true,
    };
  }
  return null;
}
