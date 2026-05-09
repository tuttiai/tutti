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
    .describe("Recipient phone number in E.164 form, no leading +."),
  template_name: z
    .string()
    .min(1)
    .max(512)
    .describe(
      "Name of the pre-approved Message Template, exactly as registered in Meta App → WhatsApp → Message Templates.",
    ),
  language_code: z
    .string()
    .min(2)
    .max(10)
    .describe(
      "Language tag of the template variant to use (e.g. 'en_US', 'fr', 'pt_BR'). Must match one of the languages the template was approved in.",
    ),
  components: z
    .array(z.unknown())
    .optional()
    .describe(
      "Optional Cloud API `components` array — header / body parameters, button payloads, etc. See <https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages#template-object>. Pass [] or omit when the template has no parameters.",
    ),
});

export function createSendTemplateMessageTool(
  client: WhatsAppClient,
): Tool<z.infer<typeof parameters>> {
  return {
    name: "send_template_message",
    description:
      "Send a pre-approved WhatsApp Message Template. Required for outbound messages OUTSIDE the 24-hour customer-service window (re-engagement). Templates must be registered and approved in the Meta App dashboard before they can be sent.",
    parameters,
    destructive: true,
    execute: async (input) => {
      const blocked = guardClient(client);
      if (blocked) return blocked;
      if (client.kind !== "ready") return { content: "unreachable", is_error: true };
      try {
        const res = await client.wrapper.sendTemplate(
          input.to,
          input.template_name,
          input.language_code,
          input.components,
        );
        return {
          content: `Sent template '${input.template_name}' (${input.language_code}) as message ${res.messageId} to ${input.to}.`,
        };
      } catch (err) {
        return {
          content: whatsappErrorMessage(err, `template '${input.template_name}' to ${input.to}`),
          is_error: true,
        };
      }
    },
  };
}
