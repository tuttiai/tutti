// Type-only imports — does not require @tuttiai/slack to be
// installed at compile time as a hard dependency. The runtime import
// below performs the actual lazy load; consumers that don't use the
// slack adapter never trigger it.
import type {
  ClientFactory,
  SlackClientWrapper,
  SlackEventLike,
  SocketModeFactory,
} from "@tuttiai/slack";
import { SecretsManager } from "@tuttiai/core";
import type { InboxAdapter, InboxMessage, InboxMessageHandler, InboxReply } from "../types.js";

export interface SlackInboxAdapterOptions {
  /** Bot user OAuth token (`xoxb-…`). Falls back to `SLACK_BOT_TOKEN`. */
  botToken?: string;
  /** App-level token (`xapp-…`) for Socket Mode. Falls back to `SLACK_APP_TOKEN`. */
  appToken?: string;
  /** Test-only — inject a mock @slack/web-api factory. */
  clientFactory?: ClientFactory;
  /** Test-only — inject a mock @slack/socket-mode factory. */
  socketModeFactory?: SocketModeFactory;
}

/**
 * Inbox adapter for Slack via Socket Mode. Dynamic-imports
 * `@tuttiai/slack` so the package is an OPTIONAL peer dependency —
 * consumers that don't use the slack adapter don't need to install it.
 *
 * Slack requires two distinct tokens for inbox-style use:
 * - `botToken` (`xoxb-…`) — used for outbound `chat.postMessage`.
 * - `appToken` (`xapp-…`) — used for the Socket Mode connection.
 *
 * The adapter resolves both, hands them to
 * `SlackClientWrapper.forToken(botToken, factory, { appToken })`, and
 * subscribes to inbound messages. The wrapper's filter drops bot
 * messages and non-default subtypes (edits, joins, …) before our
 * handler is invoked.
 */
export class SlackInboxAdapter implements InboxAdapter {
  readonly platform = "slack" as const;
  private wrapper?: SlackClientWrapper;
  private unsubscribe?: () => void;
  private started = false;

  constructor(private readonly options: SlackInboxAdapterOptions = {}) {}

  async start(handler: InboxMessageHandler): Promise<void> {
    if (this.started) return;
    const botToken = this.options.botToken ?? SecretsManager.optional("SLACK_BOT_TOKEN");
    if (!botToken) {
      throw new Error(
        "SlackInboxAdapter: SLACK_BOT_TOKEN is not set and no `botToken` was passed. Provide one before starting the inbox.",
      );
    }
    const appToken = this.options.appToken ?? SecretsManager.optional("SLACK_APP_TOKEN");
    if (!appToken) {
      throw new Error(
        "SlackInboxAdapter: SLACK_APP_TOKEN is not set and no `appToken` was passed. Socket Mode requires both a bot token and an app-level token; see https://api.slack.com/authentication/socket-mode.",
      );
    }
    const mod = await loadSlackModule();
    const inbound: { appToken: string; socketModeFactory?: SocketModeFactory } = { appToken };
    if (this.options.socketModeFactory !== undefined) {
      inbound.socketModeFactory = this.options.socketModeFactory;
    }
    this.wrapper =
      this.options.clientFactory !== undefined
        ? mod.SlackClientWrapper.forToken(botToken, this.options.clientFactory, inbound)
        : mod.SlackClientWrapper.forToken(botToken, undefined, inbound);

    this.unsubscribe = this.wrapper.subscribeMessage(async (event) => {
      const im = slackEventToInboxMessage(event);
      if (!im) return;
      try {
        await handler(im);
      } catch {
        // Defensive — orchestrator's onInbound never throws by contract.
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
      await this.wrapper.destroy();
      this.wrapper = undefined;
    }
    this.started = false;
  }

  async send(chat_id: string, reply: InboxReply): Promise<void> {
    if (!this.wrapper) {
      throw new Error("SlackInboxAdapter.send called before start().");
    }
    if (reply.text.length === 0) return;
    const client = await this.wrapper.getClient();
    await client.chat.postMessage({ channel: chat_id, text: reply.text });
  }
}

/**
 * Translate a Slack `message` event into the canonical
 * {@link InboxMessage} shape. Returns null when the event lacks an
 * identifiable user / channel / text — Slack delivers a few message
 * subtypes (e.g. file_share without text) that the wrapper's filter
 * still admits but that we drop here rather than dispatch.
 */
function slackEventToInboxMessage(event: SlackEventLike): InboxMessage | null {
  if (!event.user || !event.channel) return null;
  const text = event.text ?? "";
  // Slack ts is a string of the form "1700000000.000100" — convert to
  // unix-ms by multiplying the seconds component.
  const seconds = Number.parseFloat(event.ts);
  const timestamp = Number.isFinite(seconds) ? Math.floor(seconds * 1000) : Date.now();
  return {
    platform: "slack",
    platform_user_id: event.user,
    platform_chat_id: event.channel,
    text,
    timestamp,
    raw: event,
  };
}

let cachedModule: typeof import("@tuttiai/slack") | undefined;

async function loadSlackModule(): Promise<typeof import("@tuttiai/slack")> {
  if (cachedModule) return cachedModule;
  try {
    cachedModule = await import("@tuttiai/slack");
    return cachedModule;
  } catch (err) {
    throw new Error(
      "SlackInboxAdapter: @tuttiai/slack is not installed. Run `npm install @tuttiai/slack` (or `tutti-ai add slack`) and try again. " +
        `Underlying error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
