import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { TwitterClient } from "../client.js";
import { guardClient } from "../utils/guard.js";
import { formatUserBlock } from "../utils/render.js";
import { twErrorMessage } from "../utils/format.js";

const parameters = z.object({
  username: z
    .string()
    .min(1)
    .describe("Twitter handle without the @ (e.g. 'jack')"),
});

export function createGetUserTool(client: TwitterClient): Tool<z.infer<typeof parameters>> {
  return {
    name: "get_user",
    description: "Fetch a user's profile: bio, follower count, following count, tweet count.",
    parameters,
    execute: async (input) => {
      const blocked = guardClient(client, { need_write: false });
      if (blocked) return blocked;
      if (client.kind !== "ready") return { content: "unreachable", is_error: true };

      const handle = input.username.replace(/^@/, "");
      try {
        const res = await client.api.v2.userByUsername(handle, {
          "user.fields": ["public_metrics", "description", "created_at", "verified", "location"],
        });
        if (!res.data) {
          return { content: `User @${handle} not found.`, is_error: true };
        }
        return { content: formatUserBlock(res.data) };
      } catch (error) {
        return { content: twErrorMessage(error, `@${handle}`), is_error: true };
      }
    },
  };
}
