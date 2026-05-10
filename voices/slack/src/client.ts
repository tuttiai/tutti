import { WebClient } from "@slack/web-api";
import { SecretsManager } from "@tuttiai/core";
import {
  defaultSocketModeFactory,
  type SocketModeClientLike,
  type SocketModeFactory,
  type SlackEventLike,
} from "./socket-mode.js";

/** Narrow shape of a Slack message returned by conversations.history. */
export interface SlackMessageLike {
  type?: string;
  ts: string;
  thread_ts?: string;
  channel?: string;
  user?: string;
  bot_id?: string;
  username?: string;
  text?: string;
  edited?: { ts: string; user?: string };
  permalink?: string;
}

/** Narrow shape of a channel returned by conversations.list / .info. */
export interface SlackConversationLike {
  id: string;
  name?: string;
  is_channel?: boolean;
  is_group?: boolean;
  is_im?: boolean;
  is_mpim?: boolean;
  is_private?: boolean;
  is_archived?: boolean;
  is_member?: boolean;
  num_members?: number;
  topic?: { value?: string };
  purpose?: { value?: string };
  created?: number;
}

/** Narrow shape of a user returned by users.list / .info. */
export interface SlackUserLike {
  id: string;
  name?: string;
  real_name?: string;
  is_bot?: boolean;
  deleted?: boolean;
  updated?: number;
  profile?: {
    real_name?: string;
    display_name?: string;
    email?: string;
    title?: string;
  };
}

/** Narrow shape of team.info. */
export interface SlackTeamLike {
  id: string;
  name: string;
  domain?: string;
  email_domain?: string;
  icon?: { image_132?: string; image_88?: string; image_44?: string };
}

/**
 * Minimal shape of the @slack/web-api WebClient surface that our tools
 * touch. Declared explicitly so tools can accept mocks in tests without
 * casting through the full WebClient class.
 */
export interface SlackClientLike {
  chat: {
    postMessage(args: {
      channel: string;
      text: string;
      thread_ts?: string;
    }): Promise<{ ok: boolean; ts?: string; channel?: string; message?: SlackMessageLike }>;
    update(args: {
      channel: string;
      ts: string;
      text: string;
    }): Promise<{ ok: boolean; ts?: string; channel?: string }>;
    delete(args: {
      channel: string;
      ts: string;
    }): Promise<{ ok: boolean; ts?: string; channel?: string }>;
    getPermalink(args: {
      channel: string;
      message_ts: string;
    }): Promise<{ ok: boolean; permalink?: string }>;
  };
  reactions: {
    add(args: {
      channel: string;
      timestamp: string;
      name: string;
    }): Promise<{ ok: boolean }>;
  };
  conversations: {
    history(args: {
      channel: string;
      limit?: number;
      latest?: string;
      oldest?: string;
      inclusive?: boolean;
    }): Promise<{ ok: boolean; messages?: SlackMessageLike[]; has_more?: boolean }>;
    list(args?: {
      types?: string;
      limit?: number;
      exclude_archived?: boolean;
      cursor?: string;
    }): Promise<{
      ok: boolean;
      channels?: SlackConversationLike[];
      response_metadata?: { next_cursor?: string };
    }>;
    info(args: {
      channel: string;
    }): Promise<{ ok: boolean; channel?: SlackConversationLike }>;
    open(args: {
      users: string;
    }): Promise<{ ok: boolean; channel?: { id: string } }>;
  };
  users: {
    list(args?: {
      limit?: number;
      cursor?: string;
    }): Promise<{
      ok: boolean;
      members?: SlackUserLike[];
      response_metadata?: { next_cursor?: string };
    }>;
    info(args: {
      user: string;
    }): Promise<{ ok: boolean; user?: SlackUserLike }>;
  };
  team: {
    info(args?: { team?: string }): Promise<{ ok: boolean; team?: SlackTeamLike }>;
  };
}

/** Synchronous factory used by SlackClientWrapper; swappable in tests. */
export type ClientFactory = (token: string) => SlackClientLike;

function defaultFactory(token: string): SlackClientLike {
  // The real @slack/web-api WebClient is structurally compatible with the
  // narrow methods we declare in SlackClientLike — chat / conversations /
  // reactions / users / team are all present on the instance with the
  // matching signatures. We cast through `unknown` once at this boundary
  // to avoid leaking the wider WebClient surface into every tool.
  return new WebClient(token) as unknown as SlackClientLike;
}

/**
 * Singleton wrapper around a Slack {@link WebClient}. The client is
 * created lazily on the first tool call; subsequent calls share the
 * same instance. Safe to call {@link getClient} concurrently — concurrent
 * calls await the same in-flight construction promise.
 *
 * Slack's WebClient is stateless HTTP under the hood, so there is no
 * gateway connection to keep alive — but we still memoise so we don't
 * repeatedly allocate axios agents and retry queues.
 *
 * Construction modes:
 * - {@link forToken} (preferred) — token-keyed shared instance with
 *   reference counting. Multiple callers that ask for the same token
 *   (e.g. `voices/slack` for outbound tools and `@tuttiai/inbox` for
 *   the inbound adapter) share one wrapper; {@link destroy} only
 *   tears down once the last holder releases. Required when the same
 *   token is used in more than one place to avoid duplicate auth
 *   plumbing.
 * - `new SlackClientWrapper(token)` — standalone (not cached). Useful
 *   for tests and one-off scripts. {@link destroy} clears immediately.
 */
/**
 * Handler invoked by {@link SlackClientWrapper.subscribeMessage} for
 * every inbound non-bot, no-subtype `message` event delivered through
 * Socket Mode. The wrapper filters out bot messages (`bot_id`) and
 * non-default message subtypes (edits, channel-joins, …) before
 * dispatch, so handlers don't need to re-implement the loop guard.
 */
export type SlackMessageHandler = (event: SlackEventLike) => void | Promise<void>;

/** Optional Socket Mode configuration on {@link SlackClientWrapper.forToken}. */
export interface SlackInboundOptions {
  /**
   * App-level token (`xapp-…`) for Socket Mode. Without this the
   * wrapper has no inbound capability — `subscribeMessage` will throw
   * on the first registration.
   */
  appToken?: string;
  /** Custom Socket Mode factory — primarily for tests. */
  socketModeFactory?: SocketModeFactory;
}

export class SlackClientWrapper {
  /** Token-keyed cache of shared wrappers. Exposed for tests. */
  static readonly cache = new Map<string, SlackClientWrapper>();

  private client?: SlackClientLike;
  private initPromise?: Promise<SlackClientLike>;
  private cacheKey?: string;
  private refCount = 0;
  private appToken?: string;
  private socketModeFactory: SocketModeFactory = defaultSocketModeFactory;
  private socket?: SocketModeClientLike;
  private socketStarted = false;
  private socketStartPromise?: Promise<void>;
  private readonly subscribers = new Set<SlackMessageHandler>();
  private dispatcherInstalled = false;

  /**
   * Get-or-create a shared, ref-counted wrapper for the given bot
   * token. Subsequent calls with the same token return the same
   * instance and bump the ref-count; the underlying state is only
   * released when {@link destroy} has been called once per `forToken`
   * call.
   *
   * The cache key is the bot token (`xoxb-…`) — the canonical Slack
   * identity. Pass `inbound.appToken` to enable Socket Mode for
   * inbox-style use; the first caller's `appToken` wins. Subsequent
   * `forToken` calls with a *different* `appToken` are silently
   * accepted but the wrapper keeps the original — Socket Mode is
   * single-connection per app.
   */
  static forToken(
    token: string,
    factory: ClientFactory = defaultFactory,
    inbound: SlackInboundOptions = {},
  ): SlackClientWrapper {
    const existing = this.cache.get(token);
    if (existing) {
      existing.refCount += 1;
      // Promote inbound config from the first caller that supplies it,
      // so `voices/slack` (outbound, no appToken) followed by
      // `@tuttiai/inbox` (inbound, with appToken) ends up Socket-Mode-
      // ready without forcing a destroy/recreate cycle.
      if (existing.appToken === undefined && inbound.appToken !== undefined) {
        existing.appToken = inbound.appToken;
        if (inbound.socketModeFactory !== undefined) {
          existing.socketModeFactory = inbound.socketModeFactory;
        }
      }
      return existing;
    }
    const wrapper = new SlackClientWrapper(token, factory);
    wrapper.cacheKey = token;
    wrapper.refCount = 1;
    if (inbound.appToken !== undefined) wrapper.appToken = inbound.appToken;
    if (inbound.socketModeFactory !== undefined) {
      wrapper.socketModeFactory = inbound.socketModeFactory;
    }
    this.cache.set(token, wrapper);
    return wrapper;
  }

  constructor(
    private readonly token: string,
    private readonly factory: ClientFactory = defaultFactory,
  ) {}

  async getClient(): Promise<SlackClientLike> {
    if (this.client) return this.client;
    if (this.initPromise) return this.initPromise;

    // Factory is synchronous, but we cache as a Promise so concurrent
    // callers between the assignment and resolution share the same value.
    this.initPromise = Promise.resolve().then(() => {
      const c = this.factory(this.token);
      this.client = c;
      return c;
    });

    try {
      return await this.initPromise;
    } catch (err) {
      // Reset so the next call can retry from a clean state.
      this.initPromise = undefined;
      throw err;
    }
  }

  /**
   * Subscribe to inbound `message` events delivered through Socket
   * Mode. Throws synchronously if the wrapper has no `appToken` —
   * callers must construct via `forToken(botToken, factory, { appToken })`
   * before subscribing. The wrapper installs a single `slack_event`
   * dispatcher on the underlying `SocketModeClient` the first time
   * anyone subscribes; bot messages (`bot_id`) and non-default
   * subtypes (edits, channel-joins, …) are filtered out before the
   * handler is invoked.
   *
   * Eagerly triggers {@link launch} so subscribers don't have to
   * remember to start the socket explicitly. Returns an unsubscribe
   * function.
   */
  subscribeMessage(handler: SlackMessageHandler): () => void {
    if (this.appToken === undefined) {
      throw new Error(
        "SlackClientWrapper.subscribeMessage requires an `appToken` (xapp-…). " +
          "Pass one via SlackClientWrapper.forToken(botToken, factory, { appToken }) " +
          "or via SLACK_APP_TOKEN through the Slack inbox adapter.",
      );
    }
    this.subscribers.add(handler);
    void this.launch();
    return () => {
      this.subscribers.delete(handler);
    };
  }

  /**
   * Open the Socket Mode connection. Idempotent — repeated calls share
   * the same in-flight `start()`. No-op when no `appToken` is set; the
   * wrapper raises only on `subscribeMessage` so outbound-only callers
   * can ignore inbound entirely.
   */
  async launch(): Promise<void> {
    if (this.appToken === undefined) return;
    if (this.socketStarted) return;
    if (this.socketStartPromise) return this.socketStartPromise;
    this.socketStartPromise = (async () => {
      const socket = this.socket ?? this.socketModeFactory(this.appToken!);
      this.socket = socket;
      if (!this.dispatcherInstalled) {
        socket.on("slack_event", (envelope) => {
          // ack first thing — Slack retries un-acked events.
          void envelope.ack().catch(() => {
            // Failure to ack just means Slack will resend; not fatal.
          });
          const evt = envelope.body.event;
          if (!evt || evt.type !== "message") return;
          if (evt.subtype !== undefined) return;
          if (evt.bot_id !== undefined) return;
          void this.dispatchMessage(evt);
        });
        this.dispatcherInstalled = true;
      }
      await socket.start();
      this.socketStarted = true;
    })();
    try {
      await this.socketStartPromise;
    } catch (err) {
      this.socketStartPromise = undefined;
      throw err;
    }
  }

  private async dispatchMessage(event: SlackEventLike): Promise<void> {
    // Snapshot subscribers — handlers may unsubscribe themselves.
    for (const handler of [...this.subscribers]) {
      try {
        await handler(event);
      } catch {
        // Wrapper is not the place for error reporting — the inbox
        // orchestrator emits typed inbox:error events on its handler
        // throws. Swallow here to keep the dispatcher loop intact.
      }
    }
  }

  async destroy(): Promise<void> {
    if (this.cacheKey !== undefined) {
      this.refCount -= 1;
      if (this.refCount > 0) return;
      SlackClientWrapper.cache.delete(this.cacheKey);
      this.cacheKey = undefined;
      this.refCount = 0;
    }
    this.subscribers.clear();
    if (this.socket && this.socketStarted) {
      try {
        await this.socket.disconnect();
      } catch {
        // Disconnect failure is best-effort — the process is going
        // down or the wrapper is being released; nothing useful to do.
      }
    }
    this.socket = undefined;
    this.socketStarted = false;
    this.socketStartPromise = undefined;
    this.dispatcherInstalled = false;
    // The Slack WebClient holds no long-lived sockets, so destroy is just
    // a cache clear. Kept for symmetry with the discord voice + the Voice
    // teardown contract — hence the `Promise<void>` return.
    this.client = undefined;
    this.initPromise = undefined;
  }

  /** For tests and diagnostics — current shared-cache ref count. */
  get _refCount(): number {
    return this.refCount;
  }

  /** For tests — has the Socket Mode connection been started? */
  get _socketStarted(): boolean {
    return this.socketStarted;
  }
}

/** Config for creating a SlackClient. Token falls back to env. */
export interface SlackClientOptions {
  /** Bot token (xoxb-...). Defaults to SLACK_BOT_TOKEN env var. */
  token?: string;
  /** Custom WebClient factory — primarily for tests. */
  clientFactory?: ClientFactory;
}

/**
 * Resolved client state — either usable or an explanatory "missing"
 * placeholder. Tools never throw on missing auth; they hand the message
 * back as a ToolResult via `guardClient`.
 */
export type SlackClient =
  | { kind: "ready"; wrapper: SlackClientWrapper }
  | { kind: "missing"; message: string };

/**
 * Resolve bot credentials from options then env. Never throws — returns
 * `kind: "missing"` when SLACK_BOT_TOKEN is unset so individual tool
 * calls can surface the same helpful message without crashing the voice
 * at construction time.
 */
export function createSlackClient(options: SlackClientOptions = {}): SlackClient {
  const token = options.token ?? SecretsManager.optional("SLACK_BOT_TOKEN");
  if (!token) {
    return {
      kind: "missing",
      message:
        "Slack voice is not configured. Set SLACK_BOT_TOKEN to a bot user token (xoxb-...) from https://api.slack.com/apps. The app must be installed to the target workspace with at least these scopes: channels:read, channels:history, chat:write, reactions:write, users:read, team:read; add groups:read + groups:history for private channels and im:write for DMs.",
    };
  }

  return {
    kind: "ready",
    wrapper: SlackClientWrapper.forToken(token, options.clientFactory),
  };
}
