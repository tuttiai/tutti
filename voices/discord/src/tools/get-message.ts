import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { DiscordClient } from "../client.js";
import { guardClient } from "../utils/guard.js";
import { discordErrorMessage, messageUrl } from "../utils/format.js";

const parameters = z.object({
  channel_id: z.string().min(1).describe("ID of the channel containing the message"),
  message_id: z.string().min(1).describe("ID of the message to fetch"),
});

export function createGetMessageTool(client: DiscordClient): Tool<z.infer<typeof parameters>> {
  return {
    name: "get_message",
    description: "Fetch a single Discord message by id.",
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
        const msg = await channel.messages.fetch(input.message_id);
        const when = new Date(msg.createdTimestamp).toISOString();
        const edited = msg.editedTimestamp
          ? `\nEdited: ${new Date(msg.editedTimestamp).toISOString()}`
          : "";
        const lines = [
          `Message ${msg.id}`,
          `Author: @${msg.author.username}${msg.author.bot ? " [bot]" : ""}`,
          `Channel: #${channel.name ?? input.channel_id}`,
          `Sent: ${when}${edited}`,
          `URL: ${msg.url ?? messageUrl(msg.guildId, msg.channelId, msg.id)}`,
          "",
          msg.content || "(no text content)",
        ];
        return { content: lines.join("\n") };
      } catch (error) {
        return {
          content: discordErrorMessage(error, `message ${input.message_id}`),
          is_error: true,
        };
      }
    },
  };
}
