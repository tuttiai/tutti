// Type-only import — does not require @tuttiai/telegram to be
// installed at compile time as a hard dependency. The runtime import
// below performs the actual lazy load; consumers that don't use the
// telegram adapter never trigger it.
import type {
  BotFactory,
  TelegramClientWrapper,
  TelegramTextContextLike,
} from "@tuttiai/telegram";
import { SecretsManager } from "@tuttiai/core";
import type { InboxAdapter, InboxMessage, InboxMessageHandler, InboxReply } from "../types.js";

export interface TelegramInboxAdapterOptions {
  /** Bot token. Falls back to TELEGRAM_BOT_TOKEN. */
  token?: string;
  /** Reserved for webhook mode in a future release. Currently must be true (default). */
  polling?: boolean;
  /** Test-only — inject a mock telegraf bot factory. */
  clientFactory?: BotFactory;
}

/**
 * Inbox adapter for Telegram. Dynamic-imports `@tuttiai/telegram` so
 * the package is an OPTIONAL peer dependency — consumers that don't
 * use the telegram adapter don't need to install it.
 *
 * The adapter resolves the bot through
 * `TelegramClientWrapper.forToken(token)`, the same shared cache used
 * by the `@tuttiai/telegram` voice's outbound tools. A score that
 * declares both the inbox adapter and the voice with the same token
 * will end up with one telegraf bot servicing both — Telegram does
 * not allow two simultaneous polling sessions per token.
 */
export class TelegramInboxAdapter implements InboxAdapter {
  readonly platform = "telegram" as const;
  private wrapper?: TelegramClientWrapper;
  private unsubscribe?: () => void;
  private started = false;

  constructor(private readonly options: TelegramInboxAdapterOptions = {}) {
    if (options.polling === false) {
      throw new Error(
        "TelegramInboxAdapter: webhook mode is reserved for a future release. Use polling (the default).",
      );
    }
  }

  async start(handler: InboxMessageHandler): Promise<void> {
    if (this.started) return;
    const token = this.options.token ?? SecretsManager.optional("TELEGRAM_BOT_TOKEN");
    if (!token) {
      throw new Error(
        "TelegramInboxAdapter: TELEGRAM_BOT_TOKEN is not set and no `token` was passed. Provide one of the two before starting the inbox.",
      );
    }
    const mod = await loadTelegramModule();
    const factory = this.options.clientFactory;
    this.wrapper =
      factory !== undefined
        ? mod.TelegramClientWrapper.forToken(token, factory)
        : mod.TelegramClientWrapper.forToken(token);

    this.unsubscribe = this.wrapper.onText(async (ctx) => {
      const msg = telegramContextToMessage(ctx);
      if (!msg) return;
      try {
        await handler(msg);
      } catch {
        // The handler is the orchestrator's onInbound; it never throws
        // by contract. Swallow defensively so a stray throw does not
        // break the dispatcher loop.
      }
    });

    await this.wrapper.launch();
    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.wrapper) {
      await this.wrapper.destroy("inbox stop");
      this.wrapper = undefined;
    }
    this.started = false;
  }

  async send(chat_id: string, reply: InboxReply): Promise<void> {
    if (!this.wrapper) {
      throw new Error("TelegramInboxAdapter.send called before start().");
    }
    if (reply.text.length === 0) return;
    const id = chatIdToTelegramArg(chat_id);
    await this.wrapper.telegram.sendMessage(id, reply.text);
  }
}

/**
 * Translate a telegraf text-update context into the canonical
 * {@link InboxMessage} shape. Returns null when the context lacks an
 * identifiable sender — Telegram permits messages from anonymous
 * channel admins, which we currently drop rather than expose to the
 * agent (their `from.id` is shared across all admins of the channel).
 */
function telegramContextToMessage(ctx: TelegramTextContextLike): InboxMessage | null {
  const from = ctx.message.from;
  if (!from) return null;
  return {
    platform: "telegram",
    platform_user_id: String(from.id),
    platform_chat_id: String(ctx.message.chat.id),
    text: ctx.message.text,
    timestamp: ctx.message.date * 1000,
    raw: ctx,
  };
}

/** Telegram chat ids are numeric for users/groups and `@username` for channels. */
function chatIdToTelegramArg(chat_id: string): string | number {
  if (/^-?\d+$/.test(chat_id)) {
    const n = Number(chat_id);
    if (Number.isSafeInteger(n)) return n;
  }
  return chat_id;
}

let cachedModule: typeof import("@tuttiai/telegram") | undefined;

async function loadTelegramModule(): Promise<typeof import("@tuttiai/telegram")> {
  if (cachedModule) return cachedModule;
  try {
    cachedModule = await import("@tuttiai/telegram");
    return cachedModule;
  } catch (err) {
    throw new Error(
      "TelegramInboxAdapter: @tuttiai/telegram is not installed. Run `npm install @tuttiai/telegram` (or `tutti-ai add telegram`) and try again. " +
        `Underlying error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
