import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { SlackClient } from "../client.js";
import { guardClient } from "../utils/guard.js";
import { slackErrorMessage } from "../utils/format.js";

const parameters = z.object({
  channel: z.string().min(1).describe("Channel ID containing the message"),
  ts: z.string().min(1).describe("Timestamp ID of the message to react to"),
  name: z
    .string()
    .min(1)
    .describe("Emoji name without colons (e.g. 'thumbsup', 'tada', 'white_check_mark')"),
});

/** Strip leading and trailing ':' if the model passed e.g. ':tada:'. */
function normaliseEmojiName(name: string): string {
  return name.replace(/^:|:$/g, "");
}

export function createAddReactionTool(client: SlackClient): Tool<z.infer<typeof parameters>> {
  return {
    name: "add_reaction",
    description:
      "Add an emoji reaction to a message. Use the emoji name without surrounding colons.",
    parameters,
    destructive: true,
    execute: async (input) => {
      const blocked = guardClient(client);
      if (blocked) return blocked;
      if (client.kind !== "ready") return { content: "unreachable", is_error: true };

      const name = normaliseEmojiName(input.name);
      try {
        const c = await client.wrapper.getClient();
        await c.reactions.add({ channel: input.channel, timestamp: input.ts, name });
        return { content: `Reacted with :${name}: to ${input.ts}` };
      } catch (error) {
        return {
          content: slackErrorMessage(error, `message ${input.ts}`),
          is_error: true,
        };
      }
    },
  };
}
