import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { SlackClient } from "../client.js";
import { guardClient } from "../utils/guard.js";
import { authorLabel, formatTs, slackErrorMessage } from "../utils/format.js";

const parameters = z.object({
  channel: z.string().min(1).describe("Channel ID containing the message"),
  ts: z.string().min(1).describe("Timestamp ID of the message to fetch"),
});

export function createGetMessageTool(client: SlackClient): Tool<z.infer<typeof parameters>> {
  return {
    name: "get_message",
    description: "Fetch a single Slack message by channel + ts.",
    parameters,
    execute: async (input) => {
      const blocked = guardClient(client);
      if (blocked) return blocked;
      if (client.kind !== "ready") return { content: "unreachable", is_error: true };

      try {
        const c = await client.wrapper.getClient();
        // conversations.history with latest = ts and limit = 1 + inclusive
        // returns just that message. This avoids needing a separate
        // conversations.replies lookup for the normal case.
        const res = await c.conversations.history({
          channel: input.channel,
          latest: input.ts,
          oldest: input.ts,
          limit: 1,
          inclusive: true,
        });
        const msg = res.messages?.[0];
        if (!msg) {
          return {
            content: `Message ${input.ts} not found in ${input.channel}.`,
            is_error: true,
          };
        }

        let permalink: string | undefined;
        try {
          const link = await c.chat.getPermalink({ channel: input.channel, message_ts: msg.ts });
          permalink = link.permalink;
        } catch {
          permalink = undefined;
        }

        const editedLine = msg.edited
          ? `\nEdited: ${formatTs(msg.edited.ts)}`
          : "";
        const threadLine =
          msg.thread_ts && msg.thread_ts !== msg.ts
            ? `\nThread: ${msg.thread_ts}`
            : "";

        const lines = [
          `Message ${msg.ts}`,
          `Author: @${authorLabel(msg)}${msg.bot_id ? " [bot]" : ""}`,
          `Channel: ${input.channel}`,
          `Sent: ${formatTs(msg.ts)}${editedLine}${threadLine}`,
          permalink ? `URL: ${permalink}` : null,
          "",
          msg.text || "(no text content)",
        ].filter((l): l is string => l !== null);
        return { content: lines.join("\n") };
      } catch (error) {
        return {
          content: slackErrorMessage(error, `message ${input.ts}`),
          is_error: true,
        };
      }
    },
  };
}
