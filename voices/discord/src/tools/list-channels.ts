import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { DiscordClient } from "../client.js";
import { guardClient } from "../utils/guard.js";
import { discordErrorMessage, truncate } from "../utils/format.js";

const parameters = z.object({
  guild_id: z.string().min(1).describe("ID of the server (guild) to list channels from"),
});

// discord.js ChannelType.GuildText === 0, GuildAnnouncement === 5, PublicThread === 11,
// PrivateThread === 12, AnnouncementThread === 10. We show text-capable channels.
const TEXTY_CHANNEL_TYPES = new Set([0, 5, 10, 11, 12]);

export function createListChannelsTool(client: DiscordClient): Tool<z.infer<typeof parameters>> {
  return {
    name: "list_channels",
    description: "List text channels in a guild (server) with id, name, and topic.",
    parameters,
    execute: async (input) => {
      const blocked = guardClient(client);
      if (blocked) return blocked;
      if (client.kind !== "ready") return { content: "unreachable", is_error: true };

      try {
        const c = await client.wrapper.getClient();
        const guild = await c.guilds.fetch(input.guild_id);
        const all = await guild.channels.fetch();

        const textChannels = Array.from(all, ([, ch]) => ch).filter(
          (ch): ch is NonNullable<typeof ch> => ch !== null && TEXTY_CHANNEL_TYPES.has(ch.type),
        );

        if (textChannels.length === 0) {
          return { content: `No text channels in guild ${guild.name}.` };
        }

        const header = `${textChannels.length} text channel${
          textChannels.length === 1 ? "" : "s"
        } in ${guild.name}:`;
        const lines = textChannels.map((ch) => {
          const topic = ch.topic ? ` — ${truncate(ch.topic, 120)}` : "";
          return `${ch.id} · #${ch.name}${topic}`;
        });
        return { content: `${header}\n\n${lines.join("\n")}` };
      } catch (error) {
        return {
          content: discordErrorMessage(error, `guild ${input.guild_id}`),
          is_error: true,
        };
      }
    },
  };
}
