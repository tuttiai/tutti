import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { EmailClient } from "../index.js";
import { guardClient } from "../utils/guard.js";
import { emailErrorMessage } from "../utils/format.js";

const parameters = z.object({
  to: z
    .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
    .describe("Recipient address(es). Typically the original sender's address."),
  subject: z
    .string()
    .min(1)
    .max(998)
    .describe(
      "Reply subject. Convention is 'Re: <original>'. The agent is responsible for the prefix — this tool does not auto-prepend.",
    ),
  text: z.string().min(1).max(200_000).describe("Plain-text body of the reply."),
  in_reply_to: z
    .string()
    .min(3)
    .describe(
      "RFC 5322 Message-ID of the message you're replying to (with surrounding angle brackets). Comes from `list_inbox` or from the inbox event payload.",
    ),
  references: z
    .array(z.string().min(3))
    .optional()
    .describe(
      "RFC 5322 References chain (oldest first). When omitted, the reply uses just `in_reply_to` — fine for the first reply in a thread; pass the full chain to keep multi-turn threads stitched together in mail clients.",
    ),
});

export function createSendReplyTool(client: EmailClient): Tool<z.infer<typeof parameters>> {
  return {
    name: "send_reply",
    description:
      "Reply to an existing email thread. Sets the In-Reply-To and References headers so providers (Gmail, Outlook, …) thread the conversation. Use `send_email` for a fresh, unthreaded message.",
    parameters,
    destructive: true,
    execute: async (input) => {
      const blocked = guardClient(client);
      if (blocked) return blocked;
      if (client.kind !== "ready") return { content: "unreachable", is_error: true };
      try {
        const refsArr = input.references ?? [];
        // Append the parent if the agent didn't already include it —
        // mail clients expect the chain to end with the message we're
        // replying to.
        const references = refsArr.includes(input.in_reply_to)
          ? refsArr
          : [...refsArr, input.in_reply_to];
        const info = await client.wrapper.send({
          to: input.to,
          subject: input.subject,
          text: input.text,
          inReplyTo: input.in_reply_to,
          references,
        });
        const id = info.messageId ?? "(no Message-ID returned)";
        return {
          content: `Sent reply ${id} (in-reply-to ${input.in_reply_to}) to ${Array.isArray(input.to) ? input.to.join(", ") : input.to}.`,
        };
      } catch (err) {
        return {
          content: emailErrorMessage(err, `reply to ${input.in_reply_to}`),
          is_error: true,
        };
      }
    },
  };
}
