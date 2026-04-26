import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { SlackClient } from "../client.js";
import { guardClient } from "../utils/guard.js";
import { slackErrorMessage } from "../utils/format.js";

const parameters = z.object({
  user: z.string().min(1).describe("Slack user ID (e.g. 'U0123ABCD') to DM"),
  text: z.string().min(1).max(40000).describe("Message body (Slack mrkdwn supported)"),
});

export function createSendDmTool(client: SlackClient): Tool<z.infer<typeof parameters>> {
  return {
    name: "send_dm",
    description:
      "Send a direct message to a user. Opens (or reuses) the DM channel and posts a message in one step. Requires im:write.",
    parameters,
    destructive: true,
    execute: async (input) => {
      const blocked = guardClient(client);
      if (blocked) return blocked;
      if (client.kind !== "ready") return { content: "unreachable", is_error: true };

      try {
        const c = await client.wrapper.getClient();
        const opened = await c.conversations.open({ users: input.user });
        const channelId = opened.channel?.id;
        if (!channelId) {
          return {
            content: `Slack opened a DM with ${input.user} but returned no channel id.`,
            is_error: true,
          };
        }
        const res = await c.chat.postMessage({ channel: channelId, text: input.text });
        const ts = res.ts ?? res.message?.ts;
        if (!ts) {
          return {
            content: `Slack accepted the DM to ${input.user} but returned no ts.`,
            is_error: true,
          };
        }
        return { content: `Sent DM ${ts} to ${input.user} (channel ${channelId})` };
      } catch (error) {
        return {
          content: slackErrorMessage(error, `user ${input.user}`),
          is_error: true,
        };
      }
    },
  };
}
