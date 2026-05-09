import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { WhatsAppClient } from "../index.js";
import { guardClient } from "../utils/guard.js";
import { whatsappErrorMessage } from "../utils/format.js";

const parameters = z.object({
  to: z
    .string()
    .min(8)
    .max(20)
    .regex(/^\d+$/, "Recipient must be a phone number in E.164 form WITHOUT a leading +.")
    .describe(
      "Recipient phone number in E.164 form, no leading + (e.g. '14155552671'). The user's WhatsApp number, not the bot's.",
    ),
  text: z
    .string()
    .min(1)
    .max(4096)
    .describe("Plain-text body. WhatsApp caps at 4096 chars per message."),
});

export function createSendTextMessageTool(
  client: WhatsAppClient,
): Tool<z.infer<typeof parameters>> {
  return {
    name: "send_text_message",
    description:
      "Send a free-form WhatsApp text message. Only valid within 24 hours of the user's last inbound message — outside that window the Cloud API rejects with code 131047 and you must use `send_template_message` instead.",
    parameters,
    destructive: true,
    execute: async (input) => {
      const blocked = guardClient(client);
      if (blocked) return blocked;
      if (client.kind !== "ready") return { content: "unreachable", is_error: true };
      try {
        const res = await client.wrapper.sendText(input.to, input.text);
        return { content: `Sent message ${res.messageId} to ${input.to}.` };
      } catch (err) {
        return { content: whatsappErrorMessage(err, `recipient ${input.to}`), is_error: true };
      }
    },
  };
}
