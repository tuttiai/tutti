import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { DiscordClient } from "../client.js";
import { guardClient } from "../utils/guard.js";
import { discordErrorMessage, truncate } from "../utils/format.js";

const parameters = z.object({
  channel_id: z.string().min(1).describe("ID of the channel to search"),
  query: z.string().min(1).describe("Case-insensitive substring to match in message content"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(25)
    .describe("Maximum matching messages to return (scans up to 100 recent messages)"),
});

// How many messages to pull before filtering. Discord's REST API caps a
// single channel fetch at 100 — that's the widest net we can cast without
// paginating. Local-filter search is "best effort over the last 100".
const SCAN_WINDOW = 100;

export function createSearchMessagesTool(
  client: DiscordClient,
): Tool<z.infer<typeof parameters>> {
  return {
    name: "search_messages",
    description:
      "Find recent messages in a channel whose content contains a substring (case-insensitive). Searches the last 100 messages only — Discord's REST API has no server-side search for bots.",
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

        const collection = await channel.messages.fetch({ limit: SCAN_WINDOW });
        const needle = input.query.toLowerCase();
        const hits = Array.from(collection, ([, m]) => m)
          .filter((m) => m.content.toLowerCase().includes(needle))
          .slice(0, input.limit);

        if (hits.length === 0) {
          return {
            content: `No matches for "${input.query}" in the last ${SCAN_WINDOW} messages of #${
              channel.name ?? input.channel_id
            }.`,
          };
        }

        const header = `${hits.length} match${hits.length === 1 ? "" : "es"} for "${input.query}" in #${
          channel.name ?? input.channel_id
        }:`;
        const lines = hits.map((m) => {
          const when = new Date(m.createdTimestamp).toISOString();
          return `${m.id} · @${m.author.username} · ${when}\n${truncate(m.content, 200)}`;
        });
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
