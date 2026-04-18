import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { TwitterClient } from "../client.js";
import { guardClient } from "../utils/guard.js";
import { tweetUrl, twErrorMessage } from "../utils/format.js";

const parameters = z.object({
  tweets: z
    .array(z.string().min(1).max(280))
    .min(2)
    .describe("Ordered list of tweet bodies (each ≤ 280 chars). Min 2 — use post_tweet for single tweets."),
});

export function createPostThreadTool(client: TwitterClient): Tool<z.infer<typeof parameters>> {
  return {
    name: "post_thread",
    description: "Publish a chained thread of tweets. Each item must be ≤ 280 characters.",
    parameters,
    destructive: true,
    execute: async (input) => {
      const blocked = guardClient(client, { need_write: true });
      if (blocked) return blocked;
      if (client.kind !== "ready") return { content: "unreachable", is_error: true };

      try {
        const results = await client.api.v2.tweetThread(input.tweets);
        const ids = results.map((r) => r.data.id);
        const rootUrl = ids.length > 0 ? tweetUrl(ids[0] as string) : "";
        return {
          content: `Posted thread of ${ids.length} tweets. IDs: ${ids.join(", ")}\nRoot: ${rootUrl}`,
        };
      } catch (error) {
        return { content: twErrorMessage(error), is_error: true };
      }
    },
  };
}
