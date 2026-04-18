import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { TwitterClient } from "../client.js";
import { guardClient } from "../utils/guard.js";
import { formatTweetLine } from "../utils/render.js";
import { twErrorMessage } from "../utils/format.js";

const parameters = z.object({
  max_results: z
    .number()
    .int()
    .min(5)
    .max(100)
    .default(20)
    .describe("How many mentions to return"),
  since_id: z
    .string()
    .optional()
    .describe("Only return mentions newer than this tweet ID (for incremental polling)"),
});

export function createListMentionsTool(client: TwitterClient): Tool<z.infer<typeof parameters>> {
  return {
    name: "list_mentions",
    description: "List recent tweets that mention the authenticated user (@me).",
    parameters,
    // listing mentions requires user context, which we only have with OAuth 1.0a
    execute: async (input) => {
      const blocked = guardClient(client, { need_write: true });
      if (blocked) return blocked;
      if (client.kind !== "ready") return { content: "unreachable", is_error: true };

      try {
        const me = await client.api.v2.me();
        const options: Record<string, unknown> = {
          max_results: input.max_results,
          "tweet.fields": ["public_metrics", "author_id", "created_at"],
          expansions: ["author_id"],
          "user.fields": ["username", "name"],
        };
        if (input.since_id) options.since_id = input.since_id;

        const page = await client.api.v2.userMentionTimeline(me.data.id, options);
        const tweets = page.tweets ?? [];
        if (tweets.length === 0) {
          return { content: "No new mentions." };
        }

        const users = page.includes?.users ?? [];
        const header = `${tweets.length} mention${tweets.length === 1 ? "" : "s"} of @${me.data.username}:`;
        const lines = tweets.map((t) => formatTweetLine(t, users));
        return { content: `${header}\n\n${lines.join("\n\n")}` };
      } catch (error) {
        return { content: twErrorMessage(error), is_error: true };
      }
    },
  };
}
