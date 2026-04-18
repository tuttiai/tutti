import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { TwitterClient } from "../client.js";
import { guardClient } from "../utils/guard.js";
import { twErrorMessage } from "../utils/format.js";

const parameters = z.object({
  tweet_id: z.string().min(1).describe("Numeric ID of the tweet to delete"),
});

export function createDeleteTweetTool(client: TwitterClient): Tool<z.infer<typeof parameters>> {
  return {
    name: "delete_tweet",
    description: "Delete one of your tweets by ID. Cannot be undone.",
    parameters,
    destructive: true,
    execute: async (input) => {
      const blocked = guardClient(client, { need_write: true });
      if (blocked) return blocked;
      if (client.kind !== "ready") return { content: "unreachable", is_error: true };

      try {
        const res = await client.api.v2.deleteTweet(input.tweet_id);
        if (!res.data.deleted) {
          return {
            content: `Twitter reported the delete call succeeded but did not mark the tweet deleted. ID: ${input.tweet_id}`,
            is_error: true,
          };
        }
        return { content: `Deleted tweet ${input.tweet_id}` };
      } catch (error) {
        return { content: twErrorMessage(error, `tweet ${input.tweet_id}`), is_error: true };
      }
    },
  };
}
