/**
 * `@tuttiai/inbox` — inbound messaging orchestrator.
 *
 * Wires platform adapters (Telegram in v0.25.0; Slack/Discord/Twitter
 * in follow-ups) to a score-defined agent and applies allow-list,
 * rate-limit, queue-bound and error-handling policy uniformly. See
 * `TuttiInbox` for the orchestrator and `adapters/*` for per-platform
 * adapters.
 */

export { TuttiInbox } from "./inbox.js";
export { InMemoryIdentityStore, identityKey } from "./identity-store.js";
export { TokenBucketRateLimit, DEFAULT_RATE_LIMIT } from "./rate-limit.js";
export { PerKeySerialQueue } from "./per-chat-queue.js";
export { TelegramInboxAdapter } from "./adapters/telegram.js";
export type { TelegramInboxAdapterOptions } from "./adapters/telegram.js";
export { SlackInboxAdapter } from "./adapters/slack.js";
export type { SlackInboxAdapterOptions } from "./adapters/slack.js";
export { DiscordInboxAdapter } from "./adapters/discord.js";
export type { DiscordInboxAdapterOptions } from "./adapters/discord.js";
export { EmailInboxAdapter, DEFAULT_THREAD_CACHE_SIZE } from "./adapters/email.js";
export type { EmailInboxAdapterOptions } from "./adapters/email.js";
export { WhatsAppInboxAdapter } from "./adapters/whatsapp.js";
export type { WhatsAppInboxAdapterOptions } from "./adapters/whatsapp.js";

export type {
  InboxAdapter,
  InboxMessage,
  InboxReply,
  InboxMessageHandler,
  IdentityStore,
  InboxRateLimitConfig,
  TuttiInboxConfig,
  InboxPlatform,
  InboxAdapterConfig,
} from "./types.js";
