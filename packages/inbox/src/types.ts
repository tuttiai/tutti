/** Public types for `@tuttiai/inbox`. */

import type { InboxPlatform, InboxAdapterConfig } from "@tuttiai/types";

/**
 * A normalised message handed from a platform-specific adapter to the
 * inbox orchestrator. Adapters are responsible for translating the
 * platform's raw payload (telegraf Context, Slack event, ...) into
 * this shape.
 */
export interface InboxMessage {
  /** Platform identifier — must match the adapter's {@link InboxAdapter.platform}. */
  platform: InboxPlatform;
  /** Platform-native user id of the sender. */
  platform_user_id: string;
  /** Platform-native chat / channel / thread id where the message lives. */
  platform_chat_id: string;
  /** UTF-8 message text. Empty strings are filtered out by the orchestrator. */
  text: string;
  /** Unix-millisecond timestamp from the platform. */
  timestamp: number;
  /**
   * Original platform payload, kept for adapters that need to inspect
   * provider-specific fields (e.g. telegraf Context). The orchestrator
   * itself never reads this.
   */
  raw: unknown;
}

/** A reply built by the orchestrator and handed back to the adapter for delivery. */
export interface InboxReply {
  /** Reply text. Empty replies are skipped (no `adapter.send` call). */
  text: string;
}

/**
 * Handler the inbox orchestrator hands to {@link InboxAdapter.start}. The
 * adapter calls this when an inbound message arrives. The orchestrator
 * applies allow-list, rate-limit and per-chat-queue policy then runs
 * the agent and dispatches the reply via {@link InboxAdapter.send} —
 * the handler's return is `void` so adapters cannot accidentally
 * couple themselves to the agent's output path.
 */
export type InboxMessageHandler = (msg: InboxMessage) => Promise<void>;

/**
 * Adapter contract — one implementation per platform. Adapters live
 * either next to a voice (e.g. `voices/telegram`) or inside
 * `@tuttiai/inbox` itself for platforms with no voice yet. They are
 * intentionally thin: dispatch inbound, deliver outbound, nothing
 * else. All policy lives in the orchestrator.
 */
export interface InboxAdapter {
  /** Discriminator matching {@link InboxMessage.platform}. */
  readonly platform: InboxPlatform;
  /**
   * Begin listening for inbound messages and route them to `handler`.
   * Idempotent — a second `start()` is a no-op. Throws synchronously
   * (or rejects) when the adapter cannot reach the platform — e.g.
   * missing token, bad credentials.
   */
  start(handler: InboxMessageHandler): Promise<void>;
  /** Stop listening and release resources. Idempotent. */
  stop(): Promise<void>;
  /** Deliver an outbound reply. Adapters must not retry implicitly. */
  send(chat_id: string, reply: InboxReply): Promise<void>;
}

/**
 * Identity → session-id mapping store. The default in-memory
 * implementation supports cross-platform `link()` so a user who
 * connects on Telegram and later authenticates on Slack can resume the
 * same conversation.
 */
export interface IdentityStore {
  /** Returns the bound session id for `identity`, or null if unbound. */
  resolve(identity: string): Promise<string | null>;
  /** Bind `identity` to `session_id`. Overrides any previous binding. */
  bind(identity: string, session_id: string): Promise<void>;
  /**
   * Merge `a` and `b` into a single equivalence class. After link(),
   * `resolve(a)` and `resolve(b)` return the same session id (the one
   * that was bound first; if both were bound, `a`'s wins).
   */
  link(a: string, b: string): Promise<void>;
}

/** Token-bucket rate-limit settings. */
export type InboxRateLimitConfig =
  | { disabled: true }
  | { messagesPerWindow: number; windowMs: number; burst?: number };

/** Constructor options for {@link TuttiInbox}. */
export interface TuttiInboxConfig {
  /** Score-defined agent that processes every inbound message. */
  agent: string;
  /** One adapter per platform. */
  adapters: InboxAdapter[];
  /** Identity store. Defaults to {@link InMemoryIdentityStore}. */
  identityStore?: IdentityStore;
  /**
   * Per-platform allow-list of `platform_user_id` strings. Platforms
   * without an entry accept all senders; an empty array blocks all.
   */
  allowedUsers?: Partial<Record<InboxPlatform, string[]>>;
  /**
   * Per-`platform_user_id` token-bucket rate limit. Default:
   * `{ messagesPerWindow: 30, windowMs: 60000, burst: 10 }`.
   */
  rateLimit?: InboxRateLimitConfig;
  /**
   * Maximum in-flight messages per `platform_chat_id`. Default 10.
   * Excess messages are dropped with reason `"queue_full"`.
   */
  maxQueuePerChat?: number;
  /**
   * Optional caller-supplied error sink. Called once per error after
   * the inbox has emitted its `inbox:error` event. Errors thrown by
   * `onError` itself are swallowed to avoid feedback loops.
   */
  onError?: (err: Error, msg?: InboxMessage) => void;
}

/** Re-export the score-side adapter config for convenience. */
export type { InboxAdapterConfig, InboxPlatform };
