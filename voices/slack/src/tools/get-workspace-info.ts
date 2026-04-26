import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { SlackClient } from "../client.js";
import { guardClient } from "../utils/guard.js";
import { slackErrorMessage } from "../utils/format.js";

const parameters = z.object({});

export function createGetWorkspaceInfoTool(
  client: SlackClient,
): Tool<z.infer<typeof parameters>> {
  return {
    name: "get_workspace_info",
    description: "Fetch the Slack workspace's id, name, domain, and icon URL.",
    parameters,
    execute: async () => {
      const blocked = guardClient(client);
      if (blocked) return blocked;
      if (client.kind !== "ready") return { content: "unreachable", is_error: true };

      try {
        const c = await client.wrapper.getClient();
        const res = await c.team.info();
        const team = res.team;
        if (!team) {
          return { content: "Slack returned no team info.", is_error: true };
        }
        const icon = team.icon?.image_132 ?? team.icon?.image_88 ?? team.icon?.image_44;
        const lines = [
          `${team.name} (${team.id})`,
          team.domain ? `Domain: ${team.domain}.slack.com` : null,
          team.email_domain ? `Email domain: ${team.email_domain}` : null,
          icon ? `Icon: ${icon}` : null,
        ].filter((l): l is string => l !== null);
        return { content: lines.join("\n") };
      } catch (error) {
        return {
          content: slackErrorMessage(error),
          is_error: true,
        };
      }
    },
  };
}
