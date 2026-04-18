import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { DiscordClient } from "../client.js";
import { guardClient } from "../utils/guard.js";
import { discordErrorMessage, formatNumber } from "../utils/format.js";

const parameters = z.object({
  guild_id: z.string().min(1).describe("ID of the guild (server) to inspect"),
});

export function createGetGuildInfoTool(client: DiscordClient): Tool<z.infer<typeof parameters>> {
  return {
    name: "get_guild_info",
    description: "Fetch a guild's name, member count, channel count, and icon URL.",
    parameters,
    execute: async (input) => {
      const blocked = guardClient(client);
      if (blocked) return blocked;
      if (client.kind !== "ready") return { content: "unreachable", is_error: true };

      try {
        const c = await client.wrapper.getClient();
        const guild = await c.guilds.fetch(input.guild_id);
        const channels = await guild.channels.fetch();
        const channelCount = Array.from(channels).length;
        const iconURL = guild.iconURL();
        const created = guild.createdTimestamp
          ? new Date(guild.createdTimestamp).toISOString()
          : "unknown";

        const lines = [
          `${guild.name} (${guild.id})`,
          `Members: ${formatNumber(guild.memberCount)}`,
          `Channels: ${formatNumber(channelCount)}`,
          `Created: ${created}`,
          iconURL ? `Icon: ${iconURL}` : null,
        ].filter((l): l is string => l !== null);

        return { content: lines.join("\n") };
      } catch (error) {
        return {
          content: discordErrorMessage(error, `guild ${input.guild_id}`),
          is_error: true,
        };
      }
    },
  };
}
