import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { SlackClient, SlackMessageLike } from "../client.js";
import { guardClient } from "../utils/guard.js";
import { authorLabel, formatTs, slackErrorMessage, truncate } from "../utils/format.js";

const parameters = z.object({
  channel: z.string().min(1).describe("Channel ID to read from"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .default(50)
    .describe("How many messages to return (max 200 per Slack page)"),
  oldest: z.string().optional().describe("Only return messages after this ts (exclusive)"),
  latest: z.string().optional().describe("Only return messages before this ts (exclusive)"),
});

/** Render a single message as a compact block for list output. */
function formatListEntry(msg: SlackMessageLike): string {
  const when = formatTs(msg.ts);
  const preview = truncate(msg.text || "(no text content)", 200);
  const thread = msg.thread_ts && msg.thread_ts !== msg.ts ? " · in-thread" : "";
  return `${msg.ts} · @${authorLabel(msg)} · ${when}${thread}\n${preview}`;
}

export function createListMessagesTool(client: SlackClient): Tool<z.infer<typeof parameters>> {
  return {
    name: "list_messages",
    description: "List recent messages from a Slack channel, newest first.",
    parameters,
    execute: async (input) => {
      const blocked = guardClient(client);
      if (blocked) return blocked;
      if (client.kind !== "ready") return { content: "unreachable", is_error: true };

      try {
        const c = await client.wrapper.getClient();
        const args: {
          channel: string;
          limit: number;
          oldest?: string;
          latest?: string;
        } = { channel: input.channel, limit: input.limit };
        if (input.oldest) args.oldest = input.oldest;
        if (input.latest) args.latest = input.latest;

        const res = await c.conversations.history(args);
        const messages = res.messages ?? [];
        if (messages.length === 0) {
          return { content: `No messages in ${input.channel}.` };
        }

        const header = `${messages.length} message${
          messages.length === 1 ? "" : "s"
        } in ${input.channel}:`;
        const lines = messages.map(formatListEntry);
        return { content: `${header}\n\n${lines.join("\n\n")}` };
      } catch (error) {
        return {
          content: slackErrorMessage(error, `channel ${input.channel}`),
          is_error: true,
        };
      }
    },
  };
}
