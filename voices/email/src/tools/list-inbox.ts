import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { EmailClient } from "../index.js";
import { guardClient } from "../utils/guard.js";
import { emailErrorMessage } from "../utils/format.js";

const parameters = z.object({
  limit: z
    .number()
    .int()
    .positive()
    .max(50)
    .optional()
    .describe("Max entries to return. Defaults to 10; capped at 50."),
  unseen_only: z
    .boolean()
    .optional()
    .describe("When true (default), only return messages without the \\Seen flag."),
  since: z
    .string()
    .datetime()
    .optional()
    .describe("ISO 8601 timestamp; only return messages received after this date."),
});

export function createListInboxTool(client: EmailClient): Tool<z.infer<typeof parameters>> {
  return {
    name: "list_inbox",
    description:
      "List recent messages in the bot's INBOX. Returns Message-ID, from, subject and date for each — pass any returned Message-ID into `send_reply.in_reply_to` to thread a response.",
    parameters,
    execute: async (input) => {
      const blocked = guardClient(client);
      if (blocked) return blocked;
      if (client.kind !== "ready") return { content: "unreachable", is_error: true };
      try {
        const args: { limit?: number; unseenOnly?: boolean; since?: Date } = {};
        if (input.limit !== undefined) args.limit = input.limit;
        if (input.unseen_only !== undefined) args.unseenOnly = input.unseen_only;
        else args.unseenOnly = true;
        if (input.since !== undefined) {
          const d = new Date(input.since);
          if (Number.isNaN(d.getTime())) {
            return { content: `Invalid 'since' timestamp: ${input.since}`, is_error: true };
          }
          args.since = d;
        }
        const entries = await client.wrapper.listMessages(args);
        if (entries.length === 0) return { content: "No matching messages." };
        const lines = entries.map((e) => {
          const fromText = e.from?.address ?? "(unknown sender)";
          const dateText = e.date ? new Date(e.date).toISOString() : "(no date)";
          const subj = e.subject ?? "(no subject)";
          return `- ${e.messageId ?? `uid:${e.uid}`} | ${dateText} | ${fromText} | ${subj}`;
        });
        return { content: `${entries.length} message${entries.length === 1 ? "" : "s"}:\n${lines.join("\n")}` };
      } catch (err) {
        return { content: emailErrorMessage(err, "list_inbox"), is_error: true };
      }
    },
  };
}
