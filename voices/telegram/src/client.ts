import { Telegraf } from "telegraf";
import { SecretsManager } from "@tuttiai/core";

/** Narrow shape of the telegraf `Telegram` REST client we touch. */
export interface TelegramApiLike {
  getMe(): Promise<{ id: number; username?: string; is_bot?: boolean }>;
  sendMessage(
    chat_id: string | number,
    text: string,
    extra?: { parse_mode?: "MarkdownV2" | "HTML"; reply_to_message_id?: number },
  ): Promise<TelegramMessageLike>;
  editMessageText(
    chat_id: string | number,
    message_id: number,
    inline_message_id: undefined,
    text: string,
    extra?: { parse_mode?: "MarkdownV2" | "HTML" },
  ): Promise<true | TelegramMessageLike>;
  deleteMessage(chat_id: string | number, message_id: number): Promise<true>;
  sendPhoto(
    chat_id: string | number,
    photo: string | { source: Buffer | string },
    extra?: { caption?: string; parse_mode?: "MarkdownV2" | "HTML" },
  ): Promise<TelegramMessageLike>;
}

/** Narrow shape of a Telegram message we hand back from tools. */
export interface TelegramMessageLike {
  message_id: number;
  date: number;
  chat: { id: number; type?: string; title?: string; username?: string };
  from?: { id: number; username?: string; is_bot?: boolean };
  text?: string;
  caption?: string;
}

/**
 * Inbound text-update context. Mirrors the tiny slice of telegraf's
 * `Context` that the inbox adapter consumes — defined explicitly so
 * tests can inject mocks without casting through the full Context.
 */
export interface TelegramTextContextLike {
  message: {
    message_id: number;
    date: number;
    text: string;
    chat: { id: number; type?: string; title?: string; username?: string };
    from?: { id: number; username?: string; is_bot?: boolean };
  };
}

/**
 * Minimal shape of the telegraf `Telegraf` bot that our wrapper drives.
 * Declared explicitly so tests can inject mocks without instantiating
 * a real Telegraf — which would attempt a network call on launch.
 */
export interface TelegramBotLike {
  telegram: TelegramApiLike;
  on(filter: "text", handler: (ctx: TelegramTextContextLike) => void | Promise<void>): void;
  launch(opts?: { dropPendingUpdates?: boolean }): Promise<void>;
  stop(reason?: string): void;
}

/** Synchronous factory used by TelegramClientWrapper; swappable in tests. */
export type BotFactory = (token: string) => TelegramBotLike;

function defaultFactory(token: string): TelegramBotLike {
  // The real Telegraf class is structurally compatible with our narrow
  // TelegramBotLike — `telegram`, `on`, `launch`, `stop` are all present
  // with the matching signatures. Cast through `unknown` once at this
  // boundary to avoid leaking the wider Telegraf surface into tools.
  return new Telegraf(token) as unknown as TelegramBotLike;
}

type TextHandler = (ctx: TelegramTextContextLike) => void | Promise<void>;

/**
 * Singleton wrapper around a telegraf `Telegraf` bot, with a static
 * token-keyed cache + reference counting. Two callers that ask for the
 * same token (e.g. `voices/telegram` for outbound tools and
 * `@tuttiai/inbox` for the inbound adapter) share a single bot
 * instance — Telegram's `getUpdates` polling does not support two
 * concurrent pollers per token, so this is a correctness requirement,
 * not just an optimisation.
 *
 * Construction modes:
 * - {@link forToken} (preferred) — cached + ref-counted. {@link destroy}
 *   only stops the bot when the last holder releases.
 * - `new TelegramClientWrapper(token)` — standalone (not cached).
 *   Useful for tests and one-off scripts. {@link destroy} stops the
 *   bot immediately.
 *
 * Lifecycle:
 * - {@link telegram} works without launching — outbound REST calls do
 *   not need a polling loop.
 * - {@link onText} / {@link launch} are only required for inbound
 *   message handling. {@link launch} validates the token via `getMe`
 *   before kicking off polling so bad tokens fail fast.
 */
export class TelegramClientWrapper {
  /** Token-keyed cache of shared wrappers. Exposed for tests. */
  static readonly cache = new Map<string, TelegramClientWrapper>();

  private readonly bot: TelegramBotLike;
  private readonly subscribers = new Set<TextHandler>();
  private dispatcherInstalled = false;
  private launched = false;
  private launchPromise?: Promise<void>;
  private destroyed = false;
  private cacheKey?: string;
  private refCount = 0;

  /**
   * Get-or-create a shared, ref-counted wrapper for the given bot
   * token. Subsequent calls with the same token return the same
   * instance and bump the ref-count; the underlying bot is only
   * stopped when {@link destroy} has been called once per `forToken`
   * call.
   */
  static forToken(token: string, factory: BotFactory = defaultFactory): TelegramClientWrapper {
    const existing = this.cache.get(token);
    if (existing) {
      existing.refCount += 1;
      return existing;
    }
    const wrapper = new TelegramClientWrapper(token, factory);
    wrapper.cacheKey = token;
    wrapper.refCount = 1;
    this.cache.set(token, wrapper);
    return wrapper;
  }

  constructor(token: string, factory: BotFactory = defaultFactory) {
    this.bot = factory(token);
  }

  /** Telegram REST API. Safe to call without `launch()`. */
  get telegram(): TelegramApiLike {
    return this.bot.telegram;
  }

  /**
   * Subscribe a text-message handler. Returns an unsubscribe function.
   * Multiple subscribers are dispatched in registration order; a thrown
   * handler does not prevent later handlers from running.
   */
  onText(handler: TextHandler): () => void {
    this.subscribers.add(handler);
    if (!this.dispatcherInstalled) {
      // Telegraf has no `off` — install one stable dispatcher for the
      // bot's lifetime, route through our own subscriber set.
      this.bot.on("text", this.dispatchText);
      this.dispatcherInstalled = true;
    }
    return () => {
      this.subscribers.delete(handler);
    };
  }

  private dispatchText = async (ctx: TelegramTextContextLike): Promise<void> => {
    // Snapshot subscribers — handlers may unsubscribe themselves.
    for (const handler of [...this.subscribers]) {
      try {
        await handler(ctx);
      } catch {
        // Swallow — emitting to the EventBus is the orchestrator's job.
        // The wrapper's only responsibility is to keep dispatching.
      }
    }
  };

  /**
   * Validate the token and start long-polling. Idempotent — repeated
   * calls return the same in-flight promise. Telegraf's `launch()`
   * resolves only when the bot is stopped, so this method awaits the
   * pre-flight `getMe()` only and then fires polling without awaiting.
   */
  async launch(): Promise<void> {
    if (this.launched) return;
    if (this.launchPromise) return this.launchPromise;
    this.launchPromise = (async () => {
      await this.bot.telegram.getMe();
      // Fire-and-forget — telegraf's launch promise only resolves on stop.
      void this.bot.launch().catch(() => {
        // Polling errors propagate via telegraf's own logger; we keep
        // launched=true so destroy() still issues a stop().
      });
      this.launched = true;
    })();
    try {
      await this.launchPromise;
    } catch (err) {
      this.launchPromise = undefined;
      throw err;
    }
  }

  /**
   * Decrement the ref-count (when cache-managed) or stop the bot
   * (when standalone). Idempotent — second call is a no-op.
   */
  async destroy(reason: string = "destroy"): Promise<void> {
    if (this.destroyed) return;
    if (this.cacheKey !== undefined) {
      this.refCount -= 1;
      if (this.refCount > 0) return;
      TelegramClientWrapper.cache.delete(this.cacheKey);
    }
    this.destroyed = true;
    if (this.launched) {
      this.bot.stop(reason);
      this.launched = false;
    }
    // Allow async hooks to settle.
    return Promise.resolve();
  }

  /** For tests and diagnostics — current shared-cache ref count. */
  get _refCount(): number {
    return this.refCount;
  }
}

/** Config for creating a TelegramClient. Token falls back to env. */
export interface TelegramClientOptions {
  /** Bot token. Defaults to TELEGRAM_BOT_TOKEN env var. */
  token?: string;
  /** Custom bot factory — primarily for tests. */
  clientFactory?: BotFactory;
}

/**
 * Resolved client state — either usable or an explanatory "missing"
 * placeholder. Tools never throw on missing auth; they hand the
 * message back as a ToolResult via `guardClient`.
 */
export type TelegramClient =
  | { kind: "ready"; wrapper: TelegramClientWrapper }
  | { kind: "missing"; message: string };

/**
 * Resolve bot credentials from options then env. Never throws —
 * returns `kind: "missing"` when TELEGRAM_BOT_TOKEN is unset so
 * individual tool calls can surface the same helpful message without
 * crashing the voice at construction time.
 */
export function createTelegramClient(options: TelegramClientOptions = {}): TelegramClient {
  const token = options.token ?? SecretsManager.optional("TELEGRAM_BOT_TOKEN");
  if (!token) {
    return {
      kind: "missing",
      message:
        "Telegram voice is not configured. Set TELEGRAM_BOT_TOKEN to a bot token from @BotFather (https://t.me/BotFather → /newbot). For inbox use, the bot must also have privacy mode disabled (/setprivacy → Disable) if it needs to read non-mention messages in groups.",
    };
  }
  return {
    kind: "ready",
    wrapper: TelegramClientWrapper.forToken(token, options.clientFactory),
  };
}
