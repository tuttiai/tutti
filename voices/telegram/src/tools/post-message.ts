import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { TelegramClient } from "../client.js";
import { guardClient } from "../utils/guard.js";
import { telegramErrorMessage } from "../utils/format.js";

const parameters = z.object({
  chat_id: z
    .union([z.string().min(1), z.number().int()])
    .describe(
      "Target chat. Numeric chat id (e.g. 12345 or -1001234567890 for supergroups) or '@channel_username' for public channels.",
    ),
  text: z
    .string()
    .min(1)
    .max(4096)
    .describe("Message body (max 4096 chars per Telegram limit)."),
  parse_mode: z
    .enum(["MarkdownV2", "HTML"])
    .optional()
    .describe(
      "Telegram parse mode. Use HTML for safer formatting; MarkdownV2 requires escaping `_*[]()~\\`>#+-=|{}.!` in literals.",
    ),
  reply_to_message_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("If set, post as a reply to the referenced message id."),
});

export function createPostMessageTool(client: TelegramClient): Tool<z.infer<typeof parameters>> {
  return {
    name: "post_message",
    description:
      "Send a text message to a Telegram chat or channel. Returns the new message_id and chat id.",
    parameters,
    destructive: true,
    execute: async (input) => {
      const blocked = guardClient(client);
      if (blocked) return blocked;
      if (client.kind !== "ready") return { content: "unreachable", is_error: true };
      try {
        const extra: { parse_mode?: "MarkdownV2" | "HTML"; reply_to_message_id?: number } = {};
        if (input.parse_mode) extra.parse_mode = input.parse_mode;
        if (input.reply_to_message_id !== undefined) {
          extra.reply_to_message_id = input.reply_to_message_id;
        }
        const msg = await client.wrapper.telegram.sendMessage(input.chat_id, input.text, extra);
        return {
          content: `Posted message ${msg.message_id} to chat ${msg.chat.id}.`,
        };
      } catch (err) {
        return {
          content: telegramErrorMessage(err, `chat ${String(input.chat_id)}`),
          is_error: true,
        };
      }
    },
  };
}
