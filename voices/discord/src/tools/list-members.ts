import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { DiscordClient } from "../client.js";
import { guardClient } from "../utils/guard.js";
import { discordErrorMessage } from "../utils/format.js";

const parameters = z.object({
  guild_id: z.string().min(1).describe("ID of the server to list members from"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .default(100)
    .describe("Maximum members to return (max 1000 per API call)"),
});

export function createListMembersTool(client: DiscordClient): Tool<z.infer<typeof parameters>> {
  return {
    name: "list_members",
    description:
      "List members of a guild with id, username, roles, and join timestamp. Requires the Server Members privileged intent to be enabled.",
    parameters,
    execute: async (input) => {
      const blocked = guardClient(client);
      if (blocked) return blocked;
      if (client.kind !== "ready") return { content: "unreachable", is_error: true };

      try {
        const c = await client.wrapper.getClient();
        const guild = await c.guilds.fetch(input.guild_id);
        const collection = await guild.members.fetch({ limit: input.limit });
        const members = Array.from(collection, ([, m]) => m);

        if (members.length === 0) {
          return { content: `No members returned for ${guild.name} (missing intent or empty guild).` };
        }

        const header = `${members.length} member${
          members.length === 1 ? "" : "s"
        } in ${guild.name}:`;
        const lines = members.map((m) => {
          const roleNames = Array.from(m.roles.cache, ([, r]) => r.name)
            .filter((n) => n !== "@everyone")
            .join(", ");
          const joined = m.joinedTimestamp
            ? new Date(m.joinedTimestamp).toISOString()
            : "unknown";
          const rolePart = roleNames ? ` · roles: ${roleNames}` : "";
          const botPart = m.user.bot ? " [bot]" : "";
          return `${m.id} · @${m.user.username}${botPart} · joined ${joined}${rolePart}`;
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
