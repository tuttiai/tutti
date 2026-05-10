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
    .describe("Numeric id of the message to delete."),
});

export function createDeleteMessageTool(
  client: TelegramClient,
): Tool<z.infer<typeof parameters>> {
  return {
    name: "delete_message",
    description:
      "Delete a Telegram message. Bots can delete their own messages anytime; deleting other users' messages requires admin rights and the message must be < 48h old (private chats: only the bot's own messages).",
    parameters,
    destructive: true,
    execute: async (input) => {
      const blocked = guardClient(client);
      if (blocked) return blocked;
      if (client.kind !== "ready") return { content: "unreachable", is_error: true };
      try {
        await client.wrapper.telegram.deleteMessage(input.chat_id, input.message_id);
        return {
          content: `Deleted message ${input.message_id} from chat ${String(input.chat_id)}.`,
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
