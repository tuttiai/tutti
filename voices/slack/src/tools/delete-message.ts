import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { SlackClient } from "../client.js";
import { guardClient } from "../utils/guard.js";
import { slackErrorMessage } from "../utils/format.js";

const parameters = z.object({
  channel: z.string().min(1).describe("Channel ID containing the message"),
  ts: z.string().min(1).describe("Timestamp ID of the message to delete"),
});

export function createDeleteMessageTool(client: SlackClient): Tool<z.infer<typeof parameters>> {
  return {
    name: "delete_message",
    description:
      "Delete a message. Bot tokens can delete only the bot's own messages; user tokens with chat:write can delete any.",
    parameters,
    destructive: true,
    execute: async (input) => {
      const blocked = guardClient(client);
      if (blocked) return blocked;
      if (client.kind !== "ready") return { content: "unreachable", is_error: true };

      try {
        const c = await client.wrapper.getClient();
        await c.chat.delete({ channel: input.channel, ts: input.ts });
        return { content: `Deleted message ${input.ts} from ${input.channel}` };
      } catch (error) {
        return {
          content: slackErrorMessage(error, `message ${input.ts}`),
          is_error: true,
        };
      }
    },
  };
}
