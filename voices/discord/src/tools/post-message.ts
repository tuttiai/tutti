import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { DiscordClient } from "../client.js";
import { guardClient } from "../utils/guard.js";
import { discordErrorMessage, messageUrl } from "../utils/format.js";

const parameters = z.object({
  channel_id: z.string().min(1).describe("ID of the channel to post in"),
  content: z.string().min(1).max(2000).describe("Message body (max 2000 characters)"),
  reply_to_message_id: z
    .string()
    .optional()
    .describe("If set, the new message becomes a reply to this message"),
});

export function createPostMessageTool(client: DiscordClient): Tool<z.infer<typeof parameters>> {
  return {
    name: "post_message",
    description: "Post a message to a Discord channel. Optionally reply to another message.",
    parameters,
    destructive: true,
    execute: async (input) => {
      const blocked = guardClient(client);
      if (blocked) return blocked;
      if (client.kind !== "ready") return { content: "unreachable", is_error: true };

      try {
        const c = await client.wrapper.getClient();
        const channel = await c.channels.fetch(input.channel_id);
        if (!channel) {
          return {
            content: `Channel ${input.channel_id} not found or not accessible to the bot.`,
            is_error: true,
          };
        }

        const options = input.reply_to_message_id
          ? { content: input.content, reply: { messageReference: input.reply_to_message_id } }
          : { content: input.content };

        const msg = await channel.send(options);
        return {
          content: `Posted message ${msg.id} to #${channel.name ?? input.channel_id}\n${
            msg.url ?? messageUrl(msg.guildId, msg.channelId, msg.id)
          }`,
        };
      } catch (error) {
        return {
          content: discordErrorMessage(error, `channel ${input.channel_id}`),
          is_error: true,
        };
      }
    },
  };
}
