import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { SlackClient } from "../client.js";
import { guardClient } from "../utils/guard.js";
import { authorLabel, formatTs, slackErrorMessage, truncate } from "../utils/format.js";

const parameters = z.object({
  channel: z.string().min(1).describe("Channel ID to search"),
  query: z
    .string()
    .min(1)
    .describe("Case-insensitive substring to match in message text"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .default(25)
    .describe("Maximum matching messages to return (scans up to 200 recent messages)"),
});

// How many messages to pull before filtering. Slack's conversations.history
// caps a single page at 200; that's our scan window. The official
// search.messages endpoint supports server-side search but it requires a
// user (xoxp-) token, which most bot installs do not have. Local-filter
// search is "best effort over the last 200" — same approach as the
// discord voice.
const SCAN_WINDOW = 200;

export function createSearchMessagesTool(
  client: SlackClient,
): Tool<z.infer<typeof parameters>> {
  return {
    name: "search_messages",
    description:
      "Find recent messages in a channel whose text contains a substring (case-insensitive). Searches the last 200 messages only — the workspace-wide search.messages endpoint needs a user token, which bot installs do not have.",
    parameters,
    execute: async (input) => {
      const blocked = guardClient(client);
      if (blocked) return blocked;
      if (client.kind !== "ready") return { content: "unreachable", is_error: true };

      try {
        const c = await client.wrapper.getClient();
        const res = await c.conversations.history({
          channel: input.channel,
          limit: SCAN_WINDOW,
        });
        const messages = res.messages ?? [];
        const needle = input.query.toLowerCase();
        const hits = messages
          .filter((m) => (m.text ?? "").toLowerCase().includes(needle))
          .slice(0, input.limit);

        if (hits.length === 0) {
          return {
            content: `No matches for "${input.query}" in the last ${SCAN_WINDOW} messages of ${input.channel}.`,
          };
        }

        const header = `${hits.length} match${hits.length === 1 ? "" : "es"} for "${input.query}" in ${input.channel}:`;
        const lines = hits.map((m) => {
          const when = formatTs(m.ts);
          return `${m.ts} · @${authorLabel(m)} · ${when}\n${truncate(m.text ?? "", 200)}`;
        });
        return { content: `${header}\n\n${lines.join("\n\n")}` };
      } catch (error) {
        return {
          content: slackErrorMessage(error, `channel ${input.channel}`),
          is_error: true,
        };
      }
    },
  };
}
