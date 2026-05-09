import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { TelegramClient } from "../client.js";
import { guardClient } from "../utils/guard.js";
import { telegramErrorMessage } from "../utils/format.js";

const parameters = z.object({
  chat_id: z
    .union([z.string().min(1), z.number().int()])
    .describe("Chat id or '@channel_username' to receive the photo."),
  photo: z
    .string()
    .min(1)
    .describe(
      "Photo source. Either a publicly-reachable HTTPS URL or a previously-uploaded file_id from Telegram. Local file uploads are not exposed via this tool — use a hosted URL instead.",
    ),
  caption: z
    .string()
    .max(1024)
    .optional()
    .describe("Optional caption (max 1024 chars per Telegram limit)."),
  parse_mode: z.enum(["MarkdownV2", "HTML"]).optional(),
});

export function createSendPhotoTool(client: TelegramClient): Tool<z.infer<typeof parameters>> {
  return {
    name: "send_photo",
    description:
      "Send a photo to a Telegram chat or channel by URL or file_id. Returns the new message_id and the resulting chat id.",
    parameters,
    destructive: true,
    execute: async (input) => {
      const blocked = guardClient(client);
      if (blocked) return blocked;
      if (client.kind !== "ready") return { content: "unreachable", is_error: true };
      try {
        const extra: { caption?: string; parse_mode?: "MarkdownV2" | "HTML" } = {};
        if (input.caption !== undefined) extra.caption = input.caption;
        if (input.parse_mode) extra.parse_mode = input.parse_mode;
        const msg = await client.wrapper.telegram.sendPhoto(input.chat_id, input.photo, extra);
        return {
          content: `Sent photo as message ${msg.message_id} to chat ${msg.chat.id}.`,
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
