import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { SlackClient } from "../client.js";
import { guardClient } from "../utils/guard.js";
import { slackErrorMessage } from "../utils/format.js";

const parameters = z.object({
  channel: z
    .string()
    .min(1)
    .describe(
      "Channel ID (e.g. 'C0123ABCD') or channel name with leading '#'. IDs are more reliable.",
    ),
  text: z
    .string()
    .min(1)
    .max(40000)
    .describe("Message body. Slack mrkdwn is supported. Max 40000 chars; keep under 4000."),
  thread_ts: z
    .string()
    .optional()
    .describe("If set, post as a reply in the thread rooted at this ts."),
});

export function createPostMessageTool(client: SlackClient): Tool<z.infer<typeof parameters>> {
  return {
    name: "post_message",
    description:
      "Post a message to a Slack channel or thread. Returns the new message ts and a permalink.",
    parameters,
    destructive: true,
    execute: async (input) => {
      const blocked = guardClient(client);
      if (blocked) return blocked;
      if (client.kind !== "ready") return { content: "unreachable", is_error: true };

      try {
        const c = await client.wrapper.getClient();
        const args: { channel: string; text: string; thread_ts?: string } = {
          channel: input.channel,
          text: input.text,
        };
        if (input.thread_ts) args.thread_ts = input.thread_ts;

        const res = await c.chat.postMessage(args);
        const ts = res.ts ?? res.message?.ts;
        const channel = res.channel ?? input.channel;
        if (!ts) {
          return {
            content: `Slack accepted the request but returned no ts for channel ${input.channel}.`,
            is_error: true,
          };
        }

        let permalink: string | undefined;
        try {
          const link = await c.chat.getPermalink({ channel, message_ts: ts });
          permalink = link.permalink;
        } catch {
          // Permalink lookup is best-effort — never fail the post for it.
          permalink = undefined;
        }

        const tail = permalink ? `\n${permalink}` : "";
        return { content: `Posted message ${ts} to ${channel}${tail}` };
      } catch (error) {
        return {
          content: slackErrorMessage(error, `channel ${input.channel}`),
          is_error: true,
        };
      }
    },
  };
}
