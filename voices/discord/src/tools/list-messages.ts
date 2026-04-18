import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { DiscordClient, DiscordMessageLike } from "../client.js";
import { guardClient } from "../utils/guard.js";
import { discordErrorMessage, truncate } from "../utils/format.js";

const parameters = z.object({
  channel_id: z.string().min(1).describe("ID of the channel to read from"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(50)
    .describe("How many messages to return (max 100)"),
  before: z.string().optional().describe("Return messages sent before this message ID"),
  after: z.string().optional().describe("Return messages sent after this message ID"),
});

/** Render a single message as a compact block for list output. */
function formatListEntry(msg: DiscordMessageLike): string {
  const when = new Date(msg.createdTimestamp).toISOString();
  const preview = truncate(msg.content || "(no text content)", 200);
  return `${msg.id} · @${msg.author.username} · ${when}\n${preview}`;
}

export function createListMessagesTool(client: DiscordClient): Tool<z.infer<typeof parameters>> {
  return {
    name: "list_messages",
    description: "List recent messages from a Discord channel, newest first.",
    parameters,
    execute: async (input) => {
      const blocked = guardClient(client);
      if (blocked) return blocked;
      if (client.kind !== "ready") return { content: "unreachable", is_error: true };

      try {
        const c = await client.wrapper.getClient();
        const channel = await c.channels.fetch(input.channel_id);
        if (!channel) {
          return {
            content: `Channel ${input.channel_id} not found or not accessible.`,
            is_error: true,
          };
        }

        const options: { limit: number; before?: string; after?: string } = {
          limit: input.limit,
        };
        if (input.before) options.before = input.before;
        if (input.after) options.after = input.after;

        const collection = await channel.messages.fetch(options);
        const messages = Array.from(collection, ([, m]) => m);
        if (messages.length === 0) {
          return { content: `No messages in #${channel.name ?? input.channel_id}.` };
        }

        const header = `${messages.length} message${
          messages.length === 1 ? "" : "s"
        } in #${channel.name ?? input.channel_id}:`;
        const lines = messages.map(formatListEntry);
        return { content: `${header}\n\n${lines.join("\n\n")}` };
      } catch (error) {
        return {
          content: discordErrorMessage(error, `channel ${input.channel_id}`),
          is_error: true,
        };
      }
    },
  };
}
