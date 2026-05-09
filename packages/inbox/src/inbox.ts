import type { TuttiRuntime } from "@tuttiai/core";
import { SecretsManager, createLogger } from "@tuttiai/core";
import type {
  InboxAdapter,
  InboxMessage,
  InboxPlatform,
  TuttiInboxConfig,
  IdentityStore,
} from "./types.js";
import { InMemoryIdentityStore, identityKey } from "./identity-store.js";
import { TokenBucketRateLimit, DEFAULT_RATE_LIMIT } from "./rate-limit.js";
import { PerKeySerialQueue } from "./per-chat-queue.js";

const log = createLogger("inbox");

/**
 * Inbound messaging orchestrator. Wires one or more
 * {@link InboxAdapter}s to a score-defined agent and applies safety
 * policy: per-platform allow-list, per-user token-bucket rate limit,
 * per-chat serial queue with bounded depth, and uniform error
 * handling that emits typed `inbox:*` events without crashing the
 * inbox.
 *
 * Construction never starts adapters — call {@link start} explicitly
 * so callers can subscribe to events first.
 */
export class TuttiInbox {
  private readonly identityStore: IdentityStore;
  private readonly rateLimit: TokenBucketRateLimit;
  private readonly queue: PerKeySerialQueue<InboxMessage>;
  private readonly adapterByPlatform = new Map<InboxPlatform, InboxAdapter>();
  private readonly allowedUsers: Partial<Record<InboxPlatform, Set<string>>>;
  private gcTimer?: NodeJS.Timeout;
  private started = false;
  private stopping = false;

  constructor(
    private readonly runtime: TuttiRuntime,
    private readonly config: TuttiInboxConfig,
  ) {
    if (!config.agent) {
      throw new Error("TuttiInbox: config.agent is required.");
    }
    if (config.adapters.length === 0) {
      throw new Error("TuttiInbox: config.adapters must contain at least one adapter.");
    }
    for (const adapter of config.adapters) {
      if (this.adapterByPlatform.has(adapter.platform)) {
        throw new Error(
          `TuttiInbox: duplicate adapter for platform "${adapter.platform}". Each platform may appear at most once.`,
        );
      }
      this.adapterByPlatform.set(adapter.platform, adapter);
    }
    this.identityStore = config.identityStore ?? new InMemoryIdentityStore();
    this.rateLimit = new TokenBucketRateLimit(config.rateLimit ?? DEFAULT_RATE_LIMIT);
    this.queue = new PerKeySerialQueue<InboxMessage>(
      (chatId, msg) => this.dispatch(chatId, msg),
      config.maxQueuePerChat ?? 10,
    );
    this.allowedUsers = {};
    for (const [platform, ids] of Object.entries(config.allowedUsers ?? {})) {
      if (ids) {
        this.allowedUsers[platform as InboxPlatform] = new Set(ids);
      }
    }
  }

  /** Start every adapter. Idempotent — second call is a no-op. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    for (const adapter of this.adapterByPlatform.values()) {
      await adapter.start((msg) => this.onInbound(msg));
    }
    // Periodically GC idle rate-limit buckets so long-lived inboxes
    // don't accumulate state for one-message users.
    this.gcTimer = setInterval(() => this.rateLimit.gc(), 5 * 60_000);
    // Don't keep the event loop alive for the GC timer alone.
    this.gcTimer.unref?.();
  }

  /** Stop every adapter in parallel. Idempotent. */
  async stop(): Promise<void> {
    if (!this.started || this.stopping) return;
    this.stopping = true;
    if (this.gcTimer) {
      clearInterval(this.gcTimer);
      this.gcTimer = undefined;
    }
    await Promise.all(
      [...this.adapterByPlatform.values()].map(async (a) => {
        try {
          await a.stop();
        } catch (err) {
          this.emitError(a.platform, undefined, "receive", err);
        }
      }),
    );
    this.started = false;
    this.stopping = false;
  }

  /** Filter, rate-limit, and enqueue. Called by adapters via the handler. */
  private async onInbound(msg: InboxMessage): Promise<void> {
    if (msg.text.length === 0) {
      this.emitBlocked(msg, "empty_text");
      return;
    }
    const allow = this.allowedUsers[msg.platform];
    if (allow && !allow.has(msg.platform_user_id)) {
      this.emitBlocked(msg, "not_allowlisted");
      return;
    }
    if (!this.rateLimit.allow(`${msg.platform}:${msg.platform_user_id}`)) {
      this.emitBlocked(msg, "rate_limited");
      return;
    }
    const queueKey = `${msg.platform}:${msg.platform_chat_id}`;
    if (!this.queue.enqueue(queueKey, msg)) {
      this.emitBlocked(msg, "queue_full");
    }
  }

  /** Per-chat serial worker. Runs the agent and ships the reply. */
  private async dispatch(_queueKey: string, msg: InboxMessage): Promise<void> {
    const adapter = this.adapterByPlatform.get(msg.platform);
    if (!adapter) {
      // Should be unreachable — every inbound message comes from a
      // registered adapter — but guard so a config edit doesn't cause
      // a silent drop.
      this.emitError(msg.platform, msg.platform_chat_id, "dispatch", new Error(
        `No adapter registered for platform "${msg.platform}".`,
      ));
      return;
    }

    const startedAt = Date.now();
    this.runtime.events.emit({
      type: "inbox:message_received",
      agent_name: this.config.agent,
      platform: msg.platform,
      platform_user_id: msg.platform_user_id,
      platform_chat_id: msg.platform_chat_id,
      text_length: msg.text.length,
    });

    let sessionId: string | undefined;
    try {
      const key = identityKey(msg.platform, msg.platform_user_id);
      sessionId = (await this.identityStore.resolve(key)) ?? undefined;
      const result = await this.runtime.run(this.config.agent, msg.text, sessionId);
      if (!sessionId) {
        await this.identityStore.bind(key, result.session_id);
      }
      const replyText = result.output;
      if (replyText && replyText.length > 0) {
        await adapter.send(msg.platform_chat_id, { text: replyText });
      }
      this.runtime.events.emit({
        type: "inbox:message_replied",
        agent_name: this.config.agent,
        platform: msg.platform,
        platform_chat_id: msg.platform_chat_id,
        session_id: result.session_id,
        duration_ms: Date.now() - startedAt,
      });
    } catch (err) {
      const stage = sessionId === undefined ? "dispatch" : "reply";
      this.emitError(msg.platform, msg.platform_chat_id, stage, err, msg);
    }
  }

  private emitBlocked(
    msg: InboxMessage,
    reason: "not_allowlisted" | "rate_limited" | "queue_full" | "empty_text",
  ): void {
    this.runtime.events.emit({
      type: "inbox:message_blocked",
      platform: msg.platform,
      platform_user_id: msg.platform_user_id,
      platform_chat_id: msg.platform_chat_id,
      reason,
    });
  }

  private emitError(
    platform: InboxPlatform,
    platform_chat_id: string | undefined,
    stage: "receive" | "dispatch" | "reply",
    err: unknown,
    msg?: InboxMessage,
  ): void {
    const error = err instanceof Error ? err : new Error(String(err));
    const redacted = SecretsManager.redact(error.message);
    this.runtime.events.emit({
      type: "inbox:error",
      platform,
      ...(platform_chat_id !== undefined ? { platform_chat_id } : {}),
      stage,
      error_message: redacted,
    });
    log.warn(
      { platform, stage, error: redacted },
      "Inbox error (non-fatal — adapters keep running)",
    );
    if (this.config.onError) {
      try {
        this.config.onError(error, msg);
      } catch {
        // Swallow — never let the error sink itself crash the inbox.
      }
    }
  }
}
