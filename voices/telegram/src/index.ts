import type { Permission, Tool, Voice } from "@tuttiai/types";
import {
  createTelegramClient,
  type TelegramClient,
  type TelegramClientOptions,
} from "./client.js";
import { createPostMessageTool } from "./tools/post-message.js";
import { createEditMessageTool } from "./tools/edit-message.js";
import { createDeleteMessageTool } from "./tools/delete-message.js";
import { createSendPhotoTool } from "./tools/send-photo.js";

/** Options for {@link TelegramVoice}. */
export type TelegramVoiceOptions = TelegramClientOptions;

/**
 * Gives agents the ability to read, post and moderate Telegram
 * messages via a bot token. Write tools are marked `destructive: true`
 * so HITL-enabled runtimes gate them behind human approval.
 *
 * The underlying telegraf bot is shared via the
 * {@link TelegramClientWrapper.forToken} cache, so a score that uses
 * both `@tuttiai/telegram` (outbound tools) and `@tuttiai/inbox`
 * (inbound) sees a single Telegram bot connection — Telegram does not
 * permit two simultaneous polling sessions per token.
 */
export class TelegramVoice implements Voice {
  name = "telegram";
  description = "Read, post and moderate Telegram messages via a bot token";
  required_permissions: Permission[] = ["network"];
  tools: Tool[];

  private readonly client: TelegramClient;

  constructor(options: TelegramVoiceOptions = {}) {
    this.client = createTelegramClient(options);
    this.tools = [
      createPostMessageTool(this.client),
      createEditMessageTool(this.client),
      createDeleteMessageTool(this.client),
      createSendPhotoTool(this.client),
    ];
  }

  async teardown(): Promise<void> {
    if (this.client.kind === "ready") {
      await this.client.wrapper.destroy("voice teardown");
    }
  }
}

export { createTelegramClient, TelegramClientWrapper } from "./client.js";
export type {
  TelegramClient,
  TelegramClientOptions,
  TelegramApiLike,
  TelegramBotLike,
  TelegramMessageLike,
  TelegramTextContextLike,
  BotFactory,
} from "./client.js";
