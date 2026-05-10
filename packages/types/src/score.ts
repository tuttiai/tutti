/** Score — the top-level configuration file (tutti.score.ts). */

import type { AgentConfig } from "./agent.js";
import type { LLMProvider } from "./llm.js";
import type { TuttiHooks } from "./hooks.js";

export interface MemoryConfig {
  provider: "in-memory" | "postgres" | "redis";
  /**
   * Connection URL for database-backed providers. Ignored by `in-memory`.
   *
   * - `postgres` — a PostgreSQL connection string, e.g.
   *   `postgres://user:pass@host:5432/db` (commonly stored in
   *   `DATABASE_URL`).
   * - `redis` — a Redis connection URL, e.g.
   *   `redis://default:pass@host:6379/0` (commonly stored in `REDIS_URL`).
   *   Note: the Redis-backed session store is not yet implemented — the
   *   enum value is reserved.
   */
  url?: string;
}

export interface TelemetryConfig {
  enabled: boolean;
  /** OTLP HTTP endpoint (default: http://localhost:4318). */
  endpoint?: string;
  /** Extra headers sent with OTLP requests (e.g. auth tokens). */
  headers?: Record<string, string>;
  /**
   * Configures the `@tuttiai/telemetry` exporter pipeline, which forwards
   * in-process `TuttiSpan` events to OTLP-compatible backends. Independent
   * of the OpenTelemetry SDK setup gated by `enabled` above.
   */
  otlp?: {
    /** Full URL of the OTLP/HTTP traces endpoint (e.g. `http://localhost:4318/v1/traces`). */
    endpoint: string;
    /** Optional headers — vendor auth tokens, tenant ids, etc. */
    headers?: Record<string, string>;
  };
  /**
   * Append every closed span as newline-delimited JSON to this path.
   * Useful for offline analysis and CI eval artefacts.
   */
  jsonFile?: string;
  /**
   * Disable the `@tuttiai/telemetry` exporter pipeline entirely. Wins over
   * both score-file `otlp` / `jsonFile` settings and the `TUTTI_OTLP_ENDPOINT`
   * / `TUTTI_TRACE_FILE` environment variables.
   */
  disabled?: boolean;
}

/**
 * Declarative parallel entry — when set as `ScoreConfig.entry`, calling
 * `AgentRouter.run(input)` fans the input out to every listed agent
 * simultaneously instead of routing through a single orchestrator.
 */
export interface ParallelEntryConfig {
  type: "parallel";
  /** Agent IDs to run simultaneously. Must all exist in `agents`. */
  agents: string[];
}

/**
 * Platform identifier for an `@tuttiai/inbox` adapter. Telegram, Slack,
 * Discord, email and WhatsApp all ship in v0.25.0. Twitter / Signal
 * follow once their voices land. Score authors should treat this as a
 * closed enum — extensibility is via new adapters in `@tuttiai/inbox`,
 * not by setting `platform` to an arbitrary string.
 */
export type InboxPlatform = "telegram" | "slack" | "discord" | "email" | "whatsapp";

/**
 * Per-platform adapter configuration for `@tuttiai/inbox`. The
 * discriminator is `platform`; each branch holds the credentials and
 * connection options for that platform. Tokens are read from the
 * `SecretsManager` env-fallback when omitted — the score file should
 * never embed bot tokens.
 */
export type InboxAdapterConfig =
  | {
      platform: "telegram";
      /**
       * Bot token. Falls back to `TELEGRAM_BOT_TOKEN` via the
       * `SecretsManager`. Never commit this in the score — prefer the env.
       */
      token?: string;
      /**
       * Long-polling mode (default `true`). Webhook mode is deferred to a
       * later release; setting `false` is reserved.
       */
      polling?: boolean;
    }
  | {
      platform: "slack";
      /**
       * Bot user OAuth token (`xoxb-…`). Used for outbound
       * `chat.postMessage` calls and as the cache key for the shared
       * `SlackClientWrapper`. Falls back to `SLACK_BOT_TOKEN`.
       */
      botToken?: string;
      /**
       * App-level token (`xapp-…`) with the `connections:write` scope.
       * Required for Socket Mode — the inbox cannot listen without
       * one. Falls back to `SLACK_APP_TOKEN`. Distinct from
       * `botToken`; see <https://api.slack.com/authentication/socket-mode>.
       */
      appToken?: string;
    }
  | {
      platform: "discord";
      /**
       * Bot token from the Discord developer portal. Falls back to
       * `DISCORD_BOT_TOKEN`. The shared `DiscordClientWrapper.forToken`
       * cache ensures one Gateway connection per token, even when
       * `voices/discord` is also active in the same score.
       */
      token?: string;
    }
  | {
      platform: "email";
      /**
       * IMAP server connection details. Password is NEVER taken
       * inline — it falls back to `TUTTI_EMAIL_IMAP_PASSWORD` then
       * `TUTTI_EMAIL_PASSWORD` via the `SecretsManager`.
       */
      imap: { host: string; port: number; user: string; secure?: boolean };
      /**
       * SMTP server connection details. Same password rule as IMAP —
       * `TUTTI_EMAIL_SMTP_PASSWORD` then `TUTTI_EMAIL_PASSWORD`.
       */
      smtp: { host: string; port: number; user: string; secure?: boolean };
      /** Default From header on outbound mail. */
      from: string;
      /**
       * Char limit on inbound text body. Default 1_000_000 (~1 MB).
       * Larger inbound is dropped at the wrapper boundary and marked
       * Seen so it doesn't replay.
       */
      maxBodyChars?: number;
      /**
       * Run `SecretsManager.redact` on dispatched text before handing
       * to the orchestrator. Default `true`. Opt out only when the
       * agent legitimately needs to see raw credentials.
       */
      inboxRedactRawText?: boolean;
    }
  | {
      platform: "whatsapp";
      /**
       * Meta-assigned phone number id (NOT a phone number). Visible
       * in Meta App → WhatsApp → API Setup. Used as both the cache
       * key for the shared wrapper and the path component of every
       * Cloud API send call.
       */
      phoneNumberId: string;
      /**
       * Webhook listener port. Default 3848. Operator must run a
       * tunnel (Cloudflare Tunnel / ngrok / their own reverse proxy)
       * so Meta can POST to `https://<tunnel>/webhook` over the
       * public internet.
       */
      port?: number;
      /** Webhook listener bind address. Default `0.0.0.0`. */
      host?: string;
      /** Graph API version. Default `v21.0`. */
      graphApiVersion?: string;
      /** Body limit on the webhook endpoint. Default 5 MB. */
      bodyLimit?: number;
      /**
       * Run `SecretsManager.redact` on dispatched text before handing
       * to the orchestrator. Default `true`.
       */
      inboxRedactRawText?: boolean;
    };

/**
 * Inbound messaging configuration. When present, `tutti-ai inbox start`
 * boots a `TuttiInbox` that wires each declared adapter to the named
 * `agent`. Inbound messages are dispatched serially per chat, gated by
 * an optional per-user token-bucket, and optionally restricted to an
 * allow-list of platform user ids. See `@tuttiai/inbox` for the full
 * orchestrator contract.
 */
export interface InboxConfig {
  /** Score-defined agent that handles inbound messages. Required. */
  agent: string;
  /** One config per platform. At least one adapter must be declared. */
  adapters: InboxAdapterConfig[];
  /**
   * Restrict inbound message processing to listed platform user ids.
   * When omitted, all messages are accepted. Per-platform — only
   * platforms with non-empty arrays are filtered. Empty arrays
   * effectively block the platform (all messages dropped).
   */
  allowedUsers?: Partial<Record<InboxPlatform, string[]>>;
  /**
   * Token-bucket rate limit per `platform_user_id`. Default is 30
   * messages per 60 seconds with a burst of 10. Set
   * `{ disabled: true }` to bypass — only safe for trusted private
   * deployments since a public bot endpoint without rate limiting can
   * be used to exhaust the configured agent budget.
   */
  rateLimit?:
    | { disabled: true }
    | { messagesPerWindow: number; windowMs: number; burst?: number };
  /**
   * Maximum number of in-flight messages per platform_chat_id before
   * additional messages are dropped with reason `"queue_full"`.
   * Default 10. The inbox processes messages serially per chat, so a
   * full queue means the chat is currently waiting on a long agent
   * run.
   */
  maxQueuePerChat?: number;
}

export interface ScoreConfig {
  name?: string;
  description?: string;
  agents: Record<string, AgentConfig>;
  provider: LLMProvider;
  default_model?: string;
  /**
   * Entry point for `AgentRouter.run()`. Either the ID of a single
   * orchestrator agent (default: `"orchestrator"`), or a `ParallelEntryConfig`
   * that fans the input out to several agents simultaneously.
   */
  entry?: string | ParallelEntryConfig;
  /** Session storage configuration (default: in-memory). */
  memory?: MemoryConfig;
  /** OpenTelemetry tracing configuration. */
  telemetry?: TelemetryConfig;
  /** Global lifecycle hooks — apply to all agents. */
  hooks?: TuttiHooks;
  /**
   * Inbound messaging configuration. When set, `tutti-ai inbox start`
   * boots a {@link InboxConfig.agent}-handling `TuttiInbox` with the
   * declared adapters.
   */
  inbox?: InboxConfig;
}
