// Type-only imports — does not require @tuttiai/discord to be
// installed at compile time as a hard dependency. The runtime import
// below performs the actual lazy load; consumers that don't use the
// discord adapter never trigger it.
import type {
  ClientFactory,
  DiscordClientWrapper,
  DiscordMessageLike,
  DiscordTextChannelLike,
} from "@tuttiai/discord";
import { SecretsManager } from "@tuttiai/core";
import type { InboxAdapter, InboxMessage, InboxMessageHandler, InboxReply } from "../types.js";

export interface DiscordInboxAdapterOptions {
  /** Bot token. Falls back to `DISCORD_BOT_TOKEN`. */
  token?: string;
  /** Test-only — inject a mock discord.js Client factory. */
  clientFactory?: ClientFactory;
}

/**
 * Inbox adapter for Discord. Dynamic-imports `@tuttiai/discord` so the
 * package is an OPTIONAL peer dependency — consumers that don't use
 * the discord adapter don't need to install it.
 *
 * The adapter resolves the bot through
 * `DiscordClientWrapper.forToken(token)`, the same shared cache used
 * by the `@tuttiai/discord` voice's outbound tools. A score that
 * declares both the inbox adapter and the voice with the same token
 * will end up with one discord.js Client servicing both — Discord's
 * Gateway API does not allow two simultaneous sessions per bot token,
 * so this is a correctness requirement.
 */
export class DiscordInboxAdapter implements InboxAdapter {
  readonly platform = "discord" as const;
  private wrapper?: DiscordClientWrapper;
  private unsubscribe?: () => void;
  private started = false;

  constructor(private readonly options: DiscordInboxAdapterOptions = {}) {}

  async start(handler: InboxMessageHandler): Promise<void> {
    if (this.started) return;
    const token = this.options.token ?? SecretsManager.optional("DISCORD_BOT_TOKEN");
    if (!token) {
      throw new Error(
        "DiscordInboxAdapter: DISCORD_BOT_TOKEN is not set and no `token` was passed. Provide one of the two before starting the inbox.",
      );
    }
    const mod = await loadDiscordModule();
    const factory = this.options.clientFactory;
    this.wrapper =
      factory !== undefined
        ? mod.DiscordClientWrapper.forToken(token, factory)
        : mod.DiscordClientWrapper.forToken(token);

    this.unsubscribe = this.wrapper.subscribeMessage(async (msg) => {
      const im = discordMessageToInboxMessage(msg);
      if (!im) return;
      try {
        await handler(im);
      } catch {
        // The orchestrator's onInbound never throws by contract.
        // Swallow defensively so a stray throw does not break the
        // dispatcher loop.
      }
    });
    // Wait for the dispatcher to actually be installed on the
    // discord.js Client before returning — otherwise the inbox
    // orchestrator would race a subsequent emitMessage in tests, and
    // production code would have a small window where inbound events
    // are silently dropped.
    await this.wrapper.whenSubscribed();
    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.wrapper) {
      await this.wrapper.destroy();
      this.wrapper = undefined;
    }
    this.started = false;
  }

  async send(chat_id: string, reply: InboxReply): Promise<void> {
    if (!this.wrapper) {
      throw new Error("DiscordInboxAdapter.send called before start().");
    }
    if (reply.text.length === 0) return;
    const client = await this.wrapper.getClient();
    const channel = await client.channels.fetch(chat_id);
    if (!channel) {
      throw new Error(`DiscordInboxAdapter.send: channel ${chat_id} not found or not accessible.`);
    }
    await sendToChannel(channel, reply.text);
  }
}

/**
 * Translate a discord.js Message into the canonical
 * {@link InboxMessage} shape. Returns null when the message has no
 * text content (e.g. attachment-only messages) — the inbox drops
 * those uniformly with reason `"empty_text"`, but it's cheaper to
 * skip them here than to make the orchestrator filter every empty
 * inbound.
 */
function discordMessageToInboxMessage(msg: DiscordMessageLike): InboxMessage | null {
  const text = msg.content ?? "";
  return {
    platform: "discord",
    platform_user_id: msg.author.id,
    platform_chat_id: msg.channelId,
    text,
    timestamp: msg.createdTimestamp,
    raw: msg,
  };
}

async function sendToChannel(
  channel: DiscordTextChannelLike,
  text: string,
): Promise<void> {
  // discord.js channel.send accepts string or { content }; use the
  // string overload for the simple text case.
  await (channel as { send(content: string): Promise<unknown> }).send(text);
}

let cachedModule: typeof import("@tuttiai/discord") | undefined;

async function loadDiscordModule(): Promise<typeof import("@tuttiai/discord")> {
  if (cachedModule) return cachedModule;
  try {
    cachedModule = await import("@tuttiai/discord");
    return cachedModule;
  } catch (err) {
    throw new Error(
      "DiscordInboxAdapter: @tuttiai/discord is not installed. Run `npm install @tuttiai/discord` (or `tutti-ai add discord`) and try again. " +
        `Underlying error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
