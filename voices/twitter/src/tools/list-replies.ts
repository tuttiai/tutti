import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { TwitterClient } from "../client.js";
import { guardClient } from "../utils/guard.js";
import { formatTweetLine } from "../utils/render.js";
import { twErrorMessage } from "../utils/format.js";

const parameters = z.object({
  tweet_id: z.string().min(1).describe("ID of the tweet whose replies you want"),
  max_results: z
    .number()
    .int()
    .min(10)
    .max(100)
    .default(20)
    .describe("How many replies to return (min 10 — Twitter API floor)"),
});

export function createListRepliesTool(client: TwitterClient): Tool<z.infer<typeof parameters>> {
  return {
    name: "list_replies",
    description: "List replies to a specific tweet (uses conversation_id search).",
    parameters,
    execute: async (input) => {
      const blocked = guardClient(client, { need_write: false });
      if (blocked) return blocked;
      if (client.kind !== "ready") return { content: "unreachable", is_error: true };

      try {
        const page = await client.api.v2.search(`conversation_id:${input.tweet_id}`, {
          max_results: input.max_results,
          "tweet.fields": ["public_metrics", "author_id", "created_at", "in_reply_to_user_id"],
          expansions: ["author_id"],
          "user.fields": ["username", "name"],
        });

        const tweets = page.tweets ?? [];
        if (tweets.length === 0) {
          return { content: `No replies found for tweet ${input.tweet_id} (or older than 7 days).` };
        }

        const users = page.includes?.users ?? [];
        const header = `${tweets.length} repl${tweets.length === 1 ? "y" : "ies"} to tweet ${input.tweet_id}:`;
        const lines = tweets.map((t) => formatTweetLine(t, users));
        return { content: `${header}\n\n${lines.join("\n\n")}` };
      } catch (error) {
        return { content: twErrorMessage(error, `tweet ${input.tweet_id}`), is_error: true };
      }
    },
  };
}
