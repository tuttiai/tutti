import { Client, GatewayIntentBits } from "discord.js";
import { SecretsManager } from "@tuttiai/core";

/** Narrow shape of an author or recipient returned by discord.js. */
export interface DiscordUserLike {
  id: string;
  username: string;
  bot?: boolean;
  send(content: string): Promise<DiscordMessageLike>;
}

/** Options we pass to `channel.send()`. */
export interface DiscordSendOptions {
  content: string;
  reply?: { messageReference: string };
}

/** Narrow shape of a message — only fields our tools touch. */
export interface DiscordMessageLike {
  id: string;
  channelId: string;
  guildId?: string | null;
  content: string;
  createdTimestamp: number;
  editedTimestamp?: number | null;
  author: { id: string; username: string; bot?: boolean };
  edit(content: string): Promise<DiscordMessageLike>;
  delete(): Promise<unknown>;
  react(emoji: string): Promise<unknown>;
  url?: string;
}

/** Narrow shape of a text channel fetched from the Client. */
export interface DiscordTextChannelLike {
  id: string;
  name?: string;
  guildId?: string | null;
  send(options: string | DiscordSendOptions): Promise<DiscordMessageLike>;
  messages: {
    fetch(id: string): Promise<DiscordMessageLike>;
    fetch(options: {
      limit?: number;
      before?: string;
      after?: string;
    }): Promise<Iterable<[string, DiscordMessageLike]>>;
  };
}

/** Narrow shape of a guild channel when listing channels. */
export interface DiscordGuildChannelLike {
  id: string;
  name: string;
  type: number;
  topic?: string | null;
  parentId?: string | null;
}

/** Narrow shape of a guild member when listing members. */
export interface DiscordGuildMemberLike {
  id: string;
  user: { id: string; username: string; bot?: boolean };
  joinedTimestamp?: number | null;
  roles: { cache: Iterable<[string, { id: string; name: string }]> };
}

/** Narrow shape of a guild fetched from the Client. */
export interface DiscordGuildLike {
  id: string;
  name: string;
  memberCount: number;
  createdTimestamp?: number;
  iconURL(): string | null;
  channels: { fetch(): Promise<Iterable<[string, DiscordGuildChannelLike | null]>> };
  members: {
    fetch(options?: { limit?: number }): Promise<Iterable<[string, DiscordGuildMemberLike]>>;
  };
}

/**
 * Minimal shape of the discord.js {@link Client} that our tools touch.
 * Declared explicitly so tools can accept mocks in tests without casting
 * through the full `Client` class surface.
 */
export interface DiscordClientLike {
  channels: { fetch(id: string): Promise<DiscordTextChannelLike | null> };
  guilds: { fetch(id: string): Promise<DiscordGuildLike> };
  users: { fetch(id: string): Promise<DiscordUserLike> };
  destroy(): Promise<void> | void;
  login(token: string): Promise<string>;
  /**
   * Subscribe to gateway events. Only `messageCreate` is part of the
   * narrow surface the wrapper itself drives; tools that need other
   * events should reach for the underlying client via tests / direct
   * use rather than expanding this interface.
   */
  on(
    event: "messageCreate",
    handler: (message: DiscordMessageLike) => void | Promise<void>,
  ): void;
}

/**
 * Handler invoked by {@link DiscordClientWrapper.subscribeMessage} for
 * every non-bot inbound `messageCreate` event. Bots' own messages and
 * messages from other bots are filtered out before the handler is
 * called — handlers don't need to re-implement the loop guard.
 */
export type DiscordMessageHandler = (msg: DiscordMessageLike) => void | Promise<void>;

/** Async factory used by DiscordClientWrapper; swappable in tests. */
export type ClientFactory = () => DiscordClientLike;

const DEFAULT_INTENTS = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.GuildMembers,
  GatewayIntentBits.MessageContent,
  // Required for inbound DMs via @tuttiai/inbox. Existing outbound
  // tools (post_message, send_dm, …) work without this intent, so it's
  // additive — no breaking change for upgraders.
  GatewayIntentBits.DirectMessages,
];

function defaultFactory(): DiscordClientLike {
  // The real discord.js Client is structurally compatible with the
  // narrow methods we declare in DiscordClientLike — channels/guilds/users
  // managers all expose `fetch(id)` + `destroy()`/`login()` with the
  // matching signatures. The wider Client class has many more members;
  // we cast through `unknown` once at this boundary to avoid leaking
  // that surface into every tool.
  return new Client({ intents: DEFAULT_INTENTS }) as unknown as DiscordClientLike;
}

/**
 * Singleton wrapper around a discord.js {@link Client}. Login is deferred
 * until the first tool call; subsequent calls share the same logged-in
 * Client. Safe to call {@link getClient} concurrently — concurrent calls
 * await the same in-flight login promise.
 *
 * Construction modes:
 * - {@link forToken} (preferred) — token-keyed shared instance with
 *   reference counting. Discord's Gateway API does not allow two
 *   simultaneous sessions per bot token, so two callers using the
 *   same token (e.g. `voices/discord` for outbound tools and
 *   `@tuttiai/inbox` for the inbound adapter) MUST share a single
 *   wrapper or one of them will be forcibly disconnected. {@link destroy}
 *   only closes the gateway connection once the last holder releases.
 * - `new DiscordClientWrapper(token)` — standalone (not cached). Useful
 *   for tests and one-off scripts. {@link destroy} closes immediately.
 */
export class DiscordClientWrapper {
  /** Token-keyed cache of shared wrappers. Exposed for tests. */
  static readonly cache = new Map<string, DiscordClientWrapper>();

  private client?: DiscordClientLike;
  private loginPromise?: Promise<DiscordClientLike>;
  private cacheKey?: string;
  private refCount = 0;
  private destroyed = false;
  private readonly subscribers = new Set<DiscordMessageHandler>();
  private dispatcherInstalled = false;
  private dispatcherInstallPromise?: Promise<void>;

  /**
   * Get-or-create a shared, ref-counted wrapper for the given token.
   * Subsequent calls with the same token return the same instance and
   * bump the ref-count; the underlying gateway connection is only
   * closed when {@link destroy} has been called once per `forToken`
   * call.
   */
  static forToken(
    token: string,
    factory: ClientFactory = defaultFactory,
  ): DiscordClientWrapper {
    const existing = this.cache.get(token);
    if (existing) {
      existing.refCount += 1;
      return existing;
    }
    const wrapper = new DiscordClientWrapper(token, factory);
    wrapper.cacheKey = token;
    wrapper.refCount = 1;
    this.cache.set(token, wrapper);
    return wrapper;
  }

  constructor(
    private readonly token: string,
    private readonly factory: ClientFactory = defaultFactory,
  ) {}

  async getClient(): Promise<DiscordClientLike> {
    if (this.client) return this.client;
    if (this.loginPromise) return this.loginPromise;

    this.loginPromise = (async () => {
      const c = this.factory();
      await c.login(this.token);
      this.client = c;
      return c;
    })();

    try {
      return await this.loginPromise;
    } catch (err) {
      // Reset so the next call can retry from a clean state.
      this.loginPromise = undefined;
      throw err;
    }
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    if (this.cacheKey !== undefined) {
      this.refCount -= 1;
      if (this.refCount > 0) return;
      DiscordClientWrapper.cache.delete(this.cacheKey);
    }
    this.destroyed = true;
    this.subscribers.clear();
    if (this.client) {
      await this.client.destroy();
      this.client = undefined;
      this.loginPromise = undefined;
      this.dispatcherInstalled = false;
      this.dispatcherInstallPromise = undefined;
    }
  }

  /**
   * Subscribe to inbound `messageCreate` events. The wrapper installs
   * a single `messageCreate` listener on the underlying Client the
   * first time anyone subscribes — discord.js has no `off()`-by-name
   * surface that we use here, so subscriber management lives in the
   * wrapper. Messages from any bot (including this one) are filtered
   * out before the handler is invoked, matching the standard Discord
   * loop-prevention pattern.
   *
   * Eagerly triggers login so subscribers don't have to remember to
   * call {@link getClient} first. The returned function unsubscribes
   * the handler; the listener stays installed on the underlying Client
   * for the wrapper's lifetime, since discord.js doesn't expose a
   * stable handler-removal path for arrow-function dispatchers.
   *
   * Subscription itself returns synchronously — fire-and-forget. To
   * await the dispatcher being installed on the Client (e.g. before
   * sending a message that would otherwise echo back), call
   * {@link whenSubscribed} after subscribing.
   */
  subscribeMessage(handler: DiscordMessageHandler): () => void {
    this.subscribers.add(handler);
    void this.installDispatcher();
    return () => {
      this.subscribers.delete(handler);
    };
  }

  /**
   * Resolves once the `messageCreate` dispatcher has been installed on
   * the underlying Client. Callers that need a live subscription
   * before proceeding (the inbox adapter is the canonical example)
   * should await this after their first {@link subscribeMessage} call.
   * Resolves immediately when the dispatcher is already installed or
   * when no subscription has been triggered yet.
   */
  whenSubscribed(): Promise<void> {
    if (this.dispatcherInstalled) return Promise.resolve();
    return this.dispatcherInstallPromise ?? Promise.resolve();
  }

  private installDispatcher(): Promise<void> {
    if (this.dispatcherInstalled) return Promise.resolve();
    if (this.dispatcherInstallPromise) return this.dispatcherInstallPromise;
    this.dispatcherInstallPromise = (async () => {
      const client = await this.getClient();
      if (this.dispatcherInstalled) return;
      client.on("messageCreate", (msg) => this.dispatchMessage(msg));
      this.dispatcherInstalled = true;
    })();
    return this.dispatcherInstallPromise.catch((err) => {
      this.dispatcherInstallPromise = undefined;
      throw err;
    });
  }

  private async dispatchMessage(msg: DiscordMessageLike): Promise<void> {
    // Loop guard — never dispatch messages from the bot itself or any
    // other bot. This is the standard Discord pattern; without it, the
    // bot's own replies would fan back through the inbox handler.
    if (msg.author.bot) return;
    // Snapshot subscribers — handlers may unsubscribe themselves.
    for (const handler of [...this.subscribers]) {
      try {
        await handler(msg);
      } catch {
        // Wrapper is not the place for error reporting — the inbox
        // orchestrator emits typed inbox:error events on its handler's
        // throws. Swallow here to keep the dispatcher loop intact.
      }
    }
  }

  /** For tests and diagnostics — current shared-cache ref count. */
  get _refCount(): number {
    return this.refCount;
  }
}

/** Config for creating a DiscordClient. Token falls back to env. */
export interface DiscordClientOptions {
  /** Bot token. Defaults to DISCORD_BOT_TOKEN env var. */
  token?: string;
  /** Custom Client factory — primarily for tests. */
  clientFactory?: ClientFactory;
}

/**
 * Resolved client state — either usable or an explanatory "missing"
 * placeholder. Tools never throw on missing auth; they hand the message
 * back as a ToolResult via {@link guardClient}.
 */
export type DiscordClient =
  | { kind: "ready"; wrapper: DiscordClientWrapper }
  | { kind: "missing"; message: string };

/**
 * Resolve bot credentials from options then env. Never throws — returns
 * `kind: "missing"` when DISCORD_BOT_TOKEN is unset so individual tool
 * calls can surface the same helpful message without crashing the voice
 * at construction time.
 */
export function createDiscordClient(options: DiscordClientOptions = {}): DiscordClient {
  const token = options.token ?? SecretsManager.optional("DISCORD_BOT_TOKEN");
  if (!token) {
    return {
      kind: "missing",
      message:
        "Discord voice is not configured. Set DISCORD_BOT_TOKEN to a bot token from https://discord.com/developers/applications. The bot must be invited to the target server with at least View Channels + Send Messages, and the Gateway Intents (Guilds, GuildMessages, GuildMembers, MessageContent) must be enabled in the developer portal.",
    };
  }

  return {
    kind: "ready",
    wrapper: DiscordClientWrapper.forToken(token, options.clientFactory),
  };
}
