import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { TwitterClient } from "../client.js";
import { guardClient } from "../utils/guard.js";
import { formatTweetBlock } from "../utils/render.js";
import { twErrorMessage } from "../utils/format.js";

const parameters = z.object({
  tweet_id: z.string().min(1).describe("Numeric tweet ID"),
});

export function createGetTweetTool(client: TwitterClient): Tool<z.infer<typeof parameters>> {
  return {
    name: "get_tweet",
    description: "Fetch one tweet's text, author, and engagement metrics.",
    parameters,
    execute: async (input) => {
      const blocked = guardClient(client, { need_write: false });
      if (blocked) return blocked;
      if (client.kind !== "ready") return { content: "unreachable", is_error: true };

      try {
        const res = await client.api.v2.singleTweet(input.tweet_id, {
          "tweet.fields": ["public_metrics", "author_id", "created_at"],
          expansions: ["author_id"],
          "user.fields": ["username", "name"],
        });
        if (!res.data) {
          return { content: `Tweet ${input.tweet_id} not found.`, is_error: true };
        }
        return { content: formatTweetBlock(res.data, res.includes?.users ?? []) };
      } catch (error) {
        return { content: twErrorMessage(error, `tweet ${input.tweet_id}`), is_error: true };
      }
    },
  };
}
