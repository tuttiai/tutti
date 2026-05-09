import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { TelegramClient } from "../client.js";
import { guardClient } from "../utils/guard.js";
import { telegramErrorMessage } from "../utils/format.js";

const parameters = z.object({
  chat_id: z
    .union([z.string().min(1), z.number().int()])
    .describe("Chat id or '@channel_username' that owns the message."),
  message_id: z
    .number()
    .int()
    .positive()
    .describe("Numeric id of the message to edit."),
  text: z
    .string()
    .min(1)
    .max(4096)
    .describe("New message text. Same length limits as post_message."),
  parse_mode: z.enum(["MarkdownV2", "HTML"]).optional(),
});

export function createEditMessageTool(client: TelegramClient): Tool<z.infer<typeof parameters>> {
  return {
    name: "edit_message",
    description:
      "Edit the text of a previously-sent Telegram message. Bot must be the original author and the message must be < 48h old.",
    parameters,
    destructive: true,
    execute: async (input) => {
      const blocked = guardClient(client);
      if (blocked) return blocked;
      if (client.kind !== "ready") return { content: "unreachable", is_error: true };
      try {
        const extra: { parse_mode?: "MarkdownV2" | "HTML" } = {};
        if (input.parse_mode) extra.parse_mode = input.parse_mode;
        await client.wrapper.telegram.editMessageText(
          input.chat_id,
          input.message_id,
          undefined,
          input.text,
          extra,
        );
        return {
          content: `Edited message ${input.message_id} in chat ${String(input.chat_id)}.`,
        };
      } catch (err) {
        return {
          content: telegramErrorMessage(
            err,
            `message ${input.message_id} in chat ${String(input.chat_id)}`,
          ),
          is_error: true,
        };
      }
    },
  };
}
