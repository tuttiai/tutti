import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { TwitterClient } from "../client.js";
import { guardClient } from "../utils/guard.js";
import { formatTweetLine } from "../utils/render.js";
import { twErrorMessage } from "../utils/format.js";

const parameters = z.object({
  username: z
    .string()
    .optional()
    .describe("Handle (without @) to fetch. Omit to fetch the authenticated user's own timeline."),
  max_results: z
    .number()
    .int()
    .min(5)
    .max(100)
    .default(20)
    .describe("How many tweets to return"),
});

export function createGetTimelineTool(client: TwitterClient): Tool<z.infer<typeof parameters>> {
  return {
    name: "get_timeline",
    description:
      "Fetch a user's recent tweets. Defaults to the authenticated user — requires OAuth 1.0a if username omitted.",
    parameters,
    execute: async (input) => {
      const needsOwn = input.username === undefined;
      const blocked = guardClient(client, { need_write: needsOwn });
      if (blocked) return blocked;
      if (client.kind !== "ready") return { content: "unreachable", is_error: true };

      try {
        let userId: string;
        let handle: string;

        if (input.username) {
          const handleStripped = input.username.replace(/^@/, "");
          const user = await client.api.v2.userByUsername(handleStripped);
          if (!user.data) {
            return { content: `User @${handleStripped} not found.`, is_error: true };
          }
          userId = user.data.id;
          handle = handleStripped;
        } else {
          const me = await client.api.v2.me();
          userId = me.data.id;
          handle = me.data.username;
        }

        const page = await client.api.v2.userTimeline(userId, {
          max_results: input.max_results,
          "tweet.fields": ["public_metrics", "author_id", "created_at"],
        });
        const tweets = page.tweets ?? [];
        if (tweets.length === 0) {
          return { content: `@${handle} has no recent tweets visible.` };
        }
        const header = `${tweets.length} recent tweet${tweets.length === 1 ? "" : "s"} from @${handle}:`;
        const lines = tweets.map((t) => formatTweetLine(t, []));
        return { content: `${header}\n\n${lines.join("\n\n")}` };
      } catch (error) {
        return { content: twErrorMessage(error), is_error: true };
      }
    },
  };
}
