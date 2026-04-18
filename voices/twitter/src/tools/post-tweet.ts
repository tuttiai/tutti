import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { TwitterClient } from "../client.js";
import { guardClient } from "../utils/guard.js";
import { extractTweetId, tweetUrl, twErrorMessage } from "../utils/format.js";

const parameters = z.object({
  text: z
    .string()
    .min(1)
    .max(280)
    .describe("Tweet body (max 280 characters)"),
  reply_to: z
    .string()
    .optional()
    .describe("Tweet ID to reply to"),
  quote_url: z
    .string()
    .url()
    .optional()
    .describe("Full URL of a tweet to quote (e.g. https://x.com/user/status/123...)"),
});

export function createPostTweetTool(client: TwitterClient): Tool<z.infer<typeof parameters>> {
  return {
    name: "post_tweet",
    description: "Publish a new tweet. Optionally reply to or quote-tweet another tweet.",
    parameters,
    destructive: true,
    execute: async (input) => {
      const blocked = guardClient(client, { need_write: true });
      if (blocked) return blocked;
      // Narrowed by guardClient to kind === "ready"
      if (client.kind !== "ready") return { content: "unreachable", is_error: true };

      try {
        const payload: {
          text: string;
          reply?: { in_reply_to_tweet_id: string };
          quote_tweet_id?: string;
        } = { text: input.text };

        if (input.reply_to) {
          payload.reply = { in_reply_to_tweet_id: input.reply_to };
        }

        if (input.quote_url) {
          const id = extractTweetId(input.quote_url);
          if (!id) {
            return {
              content: `Invalid quote_url: "${input.quote_url}". Expected format: https://x.com/<handle>/status/<id>.`,
              is_error: true,
            };
          }
          payload.quote_tweet_id = id;
        }

        const res = await client.api.v2.tweet(payload);
        return { content: `Posted tweet ${res.data.id}\n${tweetUrl(res.data.id)}` };
      } catch (error) {
        return { content: twErrorMessage(error), is_error: true };
      }
    },
  };
}
