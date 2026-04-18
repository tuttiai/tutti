import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { DiscordClient } from "../client.js";
import { guardClient } from "../utils/guard.js";
import { discordErrorMessage } from "../utils/format.js";

const parameters = z.object({
  user_id: z.string().min(1).describe("ID of the user to DM"),
  content: z.string().min(1).max(2000).describe("Message body (max 2000 characters)"),
});

export function createSendDmTool(client: DiscordClient): Tool<z.infer<typeof parameters>> {
  return {
    name: "send_dm",
    description:
      "Send a direct message to a user. The user must share a guild with the bot and allow DMs from server members.",
    parameters,
    destructive: true,
    execute: async (input) => {
      const blocked = guardClient(client);
      if (blocked) return blocked;
      if (client.kind !== "ready") return { content: "unreachable", is_error: true };

      try {
        const c = await client.wrapper.getClient();
        const user = await c.users.fetch(input.user_id);
        const msg = await user.send(input.content);
        return { content: `Sent DM ${msg.id} to @${user.username}` };
      } catch (error) {
        return {
          content: discordErrorMessage(error, `user ${input.user_id}`),
          is_error: true,
        };
      }
    },
  };
}
