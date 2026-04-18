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
}

/** Async factory used by DiscordClientWrapper; swappable in tests. */
export type ClientFactory = () => DiscordClientLike;

const DEFAULT_INTENTS = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.GuildMembers,
  GatewayIntentBits.MessageContent,
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
 */
export class DiscordClientWrapper {
  private client?: DiscordClientLike;
  private loginPromise?: Promise<DiscordClientLike>;

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
    if (this.client) {
      await this.client.destroy();
      this.client = undefined;
      this.loginPromise = undefined;
    }
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
    wrapper: new DiscordClientWrapper(token, options.clientFactory),
  };
}
