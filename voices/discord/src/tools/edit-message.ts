import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { DiscordClient } from "../client.js";
import { guardClient } from "../utils/guard.js";
import { discordErrorMessage } from "../utils/format.js";

const parameters = z.object({
  channel_id: z.string().min(1).describe("ID of the channel containing the message"),
  message_id: z.string().min(1).describe("ID of the message to edit"),
  content: z.string().min(1).max(2000).describe("New message body (max 2000 characters)"),
});

export function createEditMessageTool(client: DiscordClient): Tool<z.infer<typeof parameters>> {
  return {
    name: "edit_message",
    description: "Edit a message the bot previously posted. Bots can only edit their own messages.",
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
            content: `Channel ${input.channel_id} not found or not accessible.`,
            is_error: true,
          };
        }
        const msg = await channel.messages.fetch(input.message_id);
        const edited = await msg.edit(input.content);
        return { content: `Edited message ${edited.id}` };
      } catch (error) {
        return {
          content: discordErrorMessage(error, `message ${input.message_id}`),
          is_error: true,
        };
      }
    },
  };
}
