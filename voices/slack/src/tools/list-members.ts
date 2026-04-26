import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { SlackClient } from "../client.js";
import { guardClient } from "../utils/guard.js";
import { slackErrorMessage } from "../utils/format.js";

const parameters = z.object({
  limit: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .default(200)
    .describe("Maximum members to return (single Slack page; max 1000)"),
  include_deleted: z
    .boolean()
    .default(false)
    .describe("Include deactivated/deleted users"),
  include_bots: z
    .boolean()
    .default(false)
    .describe("Include bot users in the result"),
});

export function createListMembersTool(client: SlackClient): Tool<z.infer<typeof parameters>> {
  return {
    name: "list_members",
    description:
      "List members of the workspace with id, username, real name, and bot/deleted flags. Requires the users:read scope.",
    parameters,
    execute: async (input) => {
      const blocked = guardClient(client);
      if (blocked) return blocked;
      if (client.kind !== "ready") return { content: "unreachable", is_error: true };

      try {
        const c = await client.wrapper.getClient();
        const res = await c.users.list({ limit: input.limit });
        const members = (res.members ?? []).filter((m) => {
          if (!input.include_deleted && m.deleted) return false;
          if (!input.include_bots && m.is_bot) return false;
          return true;
        });

        if (members.length === 0) {
          return { content: "No matching members in workspace." };
        }

        const header = `${members.length} member${members.length === 1 ? "" : "s"}:`;
        const lines = members.map((m) => {
          const name = m.real_name ?? m.profile?.real_name ?? m.name ?? "(no name)";
          const handle = m.name ? `@${m.name}` : `@${m.id}`;
          const flags: string[] = [];
          if (m.is_bot) flags.push("bot");
          if (m.deleted) flags.push("deleted");
          const flagPart = flags.length ? ` [${flags.join(", ")}]` : "";
          return `${m.id} · ${handle} · ${name}${flagPart}`;
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
