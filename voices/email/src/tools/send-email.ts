import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { EmailClient } from "../index.js";
import { guardClient } from "../utils/guard.js";
import { emailErrorMessage } from "../utils/format.js";

const parameters = z.object({
  to: z
    .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
    .describe("Recipient address (single string or array). Standard 'Name <addr@host>' or bare addresses both work."),
  subject: z.string().min(1).max(998).describe("Email subject. RFC 5322 caps each header at 998 chars."),
  text: z.string().min(1).max(200_000).describe("Plain-text body. Up to ~200k chars — most providers accept that and beyond."),
  cc: z.union([z.string().min(1), z.array(z.string().min(1))]).optional(),
  bcc: z.union([z.string().min(1), z.array(z.string().min(1))]).optional(),
});

export function createSendEmailTool(client: EmailClient): Tool<z.infer<typeof parameters>> {
  return {
    name: "send_email",
    description:
      "Send a fresh email to one or more recipients. To reply within an existing thread (preserving conversation continuity), use `send_reply` instead.",
    parameters,
    destructive: true,
    execute: async (input) => {
      const blocked = guardClient(client);
      if (blocked) return blocked;
      if (client.kind !== "ready") return { content: "unreachable", is_error: true };
      try {
        const args: { to: string | string[]; subject: string; text: string; cc?: string | string[]; bcc?: string | string[] } = {
          to: input.to,
          subject: input.subject,
          text: input.text,
        };
        if (input.cc !== undefined) args.cc = input.cc;
        if (input.bcc !== undefined) args.bcc = input.bcc;
        const info = await client.wrapper.send(args);
        const id = info.messageId ?? "(no Message-ID returned)";
        return { content: `Sent email ${id} to ${formatRecipients(input.to)}.` };
      } catch (err) {
        return {
          content: emailErrorMessage(err, `recipients ${formatRecipients(input.to)}`),
          is_error: true,
        };
      }
    },
  };
}

function formatRecipients(to: string | string[]): string {
  return Array.isArray(to) ? to.join(", ") : to;
}
