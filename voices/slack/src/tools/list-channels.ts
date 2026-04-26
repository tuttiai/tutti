import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { SlackClient } from "../client.js";
import { guardClient } from "../utils/guard.js";
import { slackErrorMessage, truncate } from "../utils/format.js";

const parameters = z.object({
  include_private: z
    .boolean()
    .default(false)
    .describe("Include private channels the bot is a member of (requires groups:read)"),
  exclude_archived: z
    .boolean()
    .default(true)
    .describe("Hide archived channels"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .default(200)
    .describe("Maximum channels to return (single Slack page; max 1000)"),
});

export function createListChannelsTool(client: SlackClient): Tool<z.infer<typeof parameters>> {
  return {
    name: "list_channels",
    description:
      "List public (and optionally private) channels in the workspace with id, name, and topic.",
    parameters,
    execute: async (input) => {
      const blocked = guardClient(client);
      if (blocked) return blocked;
      if (client.kind !== "ready") return { content: "unreachable", is_error: true };

      try {
        const c = await client.wrapper.getClient();
        const types = input.include_private
          ? "public_channel,private_channel"
          : "public_channel";
        const res = await c.conversations.list({
          types,
          limit: input.limit,
          exclude_archived: input.exclude_archived,
        });
        const channels = res.channels ?? [];

        if (channels.length === 0) {
          return { content: "No channels found." };
        }

        const header = `${channels.length} channel${channels.length === 1 ? "" : "s"}:`;
        const lines = channels.map((ch) => {
          const topic = ch.topic?.value ? ` — ${truncate(ch.topic.value, 120)}` : "";
          const privacy = ch.is_private ? " [private]" : "";
          const archived = ch.is_archived ? " [archived]" : "";
          return `${ch.id} · #${ch.name ?? "(no name)"}${privacy}${archived}${topic}`;
        });
        return { content: `${header}\n\n${lines.join("\n")}` };
      } catch (error) {
        return {
          content: slackErrorMessage(error),
          is_error: true,
        };
      }
    },
  };
}
