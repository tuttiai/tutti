import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { SlackClient } from "../client.js";
import { guardClient } from "../utils/guard.js";
import { slackErrorMessage } from "../utils/format.js";

const parameters = z.object({
  channel: z.string().min(1).describe("Channel ID containing the message"),
  ts: z.string().min(1).describe("Timestamp ID of the message to update"),
  text: z.string().min(1).max(40000).describe("New message body (Slack mrkdwn supported)"),
});

export function createUpdateMessageTool(client: SlackClient): Tool<z.infer<typeof parameters>> {
  return {
    name: "update_message",
    description: "Edit a message the bot previously posted. Bots can only edit their own messages.",
    parameters,
    destructive: true,
    execute: async (input) => {
      const blocked = guardClient(client);
      if (blocked) return blocked;
      if (client.kind !== "ready") return { content: "unreachable", is_error: true };

      try {
        const c = await client.wrapper.getClient();
        const res = await c.chat.update({
          channel: input.channel,
          ts: input.ts,
          text: input.text,
        });
        const ts = res.ts ?? input.ts;
        return { content: `Updated message ${ts} in ${res.channel ?? input.channel}` };
      } catch (error) {
        return {
          content: slackErrorMessage(error, `message ${input.ts}`),
          is_error: true,
        };
      }
    },
  };
}
