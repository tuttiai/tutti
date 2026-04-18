import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { TwitterClient } from "../client.js";
import { guardClient } from "../utils/guard.js";
import { formatTweetLine } from "../utils/render.js";
import { twErrorMessage } from "../utils/format.js";

const parameters = z.object({
  query: z.string().min(1).describe("Search query (Twitter search syntax)"),
  max_results: z
    .number()
    .int()
    .min(10)
    .max(100)
    .default(10)
    .describe("How many tweets to return (min 10 — Twitter API floor)"),
  filter: z
    .enum(["recent", "popular"])
    .optional()
    .describe("Sort: 'recent' = newest first, 'popular' = most engagement"),
});

export function createSearchTweetsTool(client: TwitterClient): Tool<z.infer<typeof parameters>> {
  return {
    name: "search_tweets",
    description: "Search recent tweets (last 7 days) matching a query.",
    parameters,
    execute: async (input) => {
      const blocked = guardClient(client, { need_write: false });
      if (blocked) return blocked;
      if (client.kind !== "ready") return { content: "unreachable", is_error: true };

      try {
        const options: Record<string, unknown> = {
          max_results: input.max_results,
          "tweet.fields": ["public_metrics", "author_id", "created_at"],
          expansions: ["author_id"],
          "user.fields": ["username", "name"],
        };
        if (input.filter === "popular") options.sort_order = "relevancy";
        else if (input.filter === "recent") options.sort_order = "recency";

        const page = await client.api.v2.search(input.query, options);
        const tweets = page.tweets ?? [];
        if (tweets.length === 0) {
          return { content: `No tweets matched "${input.query}" in the last 7 days.` };
        }

        const users = page.includes?.users ?? [];
        const header = `${tweets.length} tweet${tweets.length === 1 ? "" : "s"} matching "${input.query}":`;
        const lines = tweets.map((t) => formatTweetLine(t, users));
        return { content: `${header}\n\n${lines.join("\n\n")}` };
      } catch (error) {
        return { content: twErrorMessage(error), is_error: true };
      }
    },
  };
}
