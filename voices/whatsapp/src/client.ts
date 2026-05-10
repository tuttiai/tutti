import type { FastifyInstance } from "fastify";
import { SecretsManager } from "@tuttiai/core";
import { GraphClient, type FetchLike, type ResolvedMedia, type SendResult } from "./graph-client.js";
import { buildWebhookServer } from "./server.js";
import type {
  InboundMessage,
  InboundMedia,
  InboundWebhookPayload,
} from "./types.js";

/**
 * Inbound message in the canonical shape the wrapper hands to
 * subscribers. WhatsApp media types (image/audio/video/document)
 * surface as a placeholder `text` (`[image]` etc.) and a populated
 * `media` object on the wrapper-level message — the inbox adapter
 * decides how to surface them downstream.
 */
export interface WhatsAppMessage {
  /** wamid — WhatsApp Message Id, unique per message. */
  messageId: string;
  /** E.164 sender, no leading `+`. */
  from: string;
  /** Unix-millisecond timestamp. */
  timestamp: number;
  /** Plain text body, OR placeholder for non-text types. */
  text: string;
  /** Original `messages[]` element from the Cloud API. */
  raw: InboundMessage;
  /** Resolved media url + mime when the message was image/audio/video/document. */
  media?: ResolvedMedia & { kind: "image" | "audio" | "video" | "document" };
}

export type WhatsAppMessageHandler = (msg: WhatsAppMessage) => void | Promise<void>;

export interface WhatsAppClientWrapperOptions {
  phoneNumberId: string;
  accessToken: string;
  verifyToken: string;
  appSecret: string;
  port?: number;
  host?: string;
  graphApiVersion?: string;
  /** Run `SecretsManager.redact` on dispatched text. Default `true`. */
  redactRawText?: boolean;
  /** Body limit on the webhook endpoint. Default 5 MB. */
  bodyLimit?: number;
  /**
   * Per-source-IP rate limit at the webhook HTTP boundary. Defaults to
   * 100 req / 60s per IP. Pass `false` to disable when running behind
   * a trusted upstream that already rate-limits.
   */
  rateLimit?: { max?: number; windowMs?: number } | false;
  /** Test-only — inject a mock fetch for outbound Graph calls. */
  fetchFn?: FetchLike;
}

const MEDIA_KINDS = ["image", "audio", "video", "document"] as const;
type MediaKind = (typeof MEDIA_KINDS)[number];

/** Bounded LRU cap on the media-resolve cache. Default 1000. */
export const DEFAULT_MEDIA_CACHE_SIZE = 1_000;

/**
 * Wrapper around the Meta WhatsApp Cloud API + a self-hosted Fastify
 * webhook server. Single instance per `phoneNumberId` via the
 * {@link forKey} cache — the voice's outbound tools and
 * `@tuttiai/inbox`'s WhatsApp adapter share one Graph client and one
 * webhook server.
 *
 * Lifecycle:
 * - {@link subscribeMessage} registers a handler. Synchronous —
 *   doesn't open the port. Returns the unsubscribe function.
 * - {@link launch} starts listening on the configured port. Idempotent.
 * - {@link destroy} closes the Fastify server and clears state. Refs
 *   are counted across `forKey` calls; the server only stops on the
 *   last release.
 *
 * Webhook URL convention: the server hosts `GET /webhook` (Meta
 * verify handshake) and `POST /webhook` (inbound messages) on the
 * configured port (default 3848). The user must run a tunnel
 * (Cloudflare Tunnel / ngrok / their own reverse proxy) and set the
 * Meta App's Callback URL to `https://<tunnel>/webhook`.
 */
export class WhatsAppClientWrapper {
  static readonly cache = new Map<string, WhatsAppClientWrapper>();

  static keyFor(opts: { phoneNumberId: string }): string {
    return opts.phoneNumberId;
  }

  static forKey(key: string, options: WhatsAppClientWrapperOptions): WhatsAppClientWrapper {
    const existing = this.cache.get(key);
    if (existing) {
      existing.refCount += 1;
      return existing;
    }
    const wrapper = new WhatsAppClientWrapper(options);
    wrapper.cacheKey = key;
    wrapper.refCount = 1;
    this.cache.set(key, wrapper);
    return wrapper;
  }

  private readonly graph: GraphClient;
  private server?: FastifyInstance;
  private listening = false;
  private listenPromise?: Promise<void>;
  private readonly subscribers = new Set<WhatsAppMessageHandler>();
  private readonly mediaCache = new Map<string, ResolvedMedia>();
  private cacheKey?: string;
  private refCount = 0;
  private destroyed = false;

  constructor(private readonly options: WhatsAppClientWrapperOptions) {
    const graphOpts: ConstructorParameters<typeof GraphClient>[0] = {
      phoneNumberId: options.phoneNumberId,
      accessToken: options.accessToken,
    };
    if (options.graphApiVersion !== undefined) graphOpts.graphApiVersion = options.graphApiVersion;
    if (options.fetchFn !== undefined) graphOpts.fetchFn = options.fetchFn;
    this.graph = new GraphClient(graphOpts);
    this.server = buildWebhookServer({
      verifyToken: options.verifyToken,
      appSecret: options.appSecret,
      ...(options.bodyLimit !== undefined ? { bodyLimit: options.bodyLimit } : {}),
      ...(options.rateLimit !== undefined ? { rateLimit: options.rateLimit } : {}),
      onPayload: (payload) => this.handlePayload(payload),
    });
  }

  // ── inbound ────────────────────────────────────────────────────────

  subscribeMessage(handler: WhatsAppMessageHandler): () => void {
    this.subscribers.add(handler);
    return () => {
      this.subscribers.delete(handler);
    };
  }

  /** Resolves once the server is bound to its port. */
  whenSubscribed(): Promise<void> {
    if (this.listening) return Promise.resolve();
    return this.listenPromise ?? Promise.resolve();
  }

  /** Start listening on the configured port. Idempotent. */
  async launch(): Promise<void> {
    if (this.listening) return;
    if (this.listenPromise) return this.listenPromise;
    if (!this.server) {
      throw new Error("WhatsAppClientWrapper.launch: server has been destroyed.");
    }
    const server = this.server;
    const port = this.options.port ?? 3848;
    const host = this.options.host ?? "0.0.0.0";
    this.listenPromise = (async () => {
      await server.listen({ port, host });
      this.listening = true;
    })();
    try {
      await this.listenPromise;
    } catch (err) {
      this.listenPromise = undefined;
      throw err;
    }
  }

  // ── outbound ───────────────────────────────────────────────────────

  /** Send a free-form text message. Only valid within the 24h window. */
  sendText(to: string, text: string): Promise<SendResult> {
    return this.graph.sendText(to, text);
  }

  /** Send a pre-approved template message (required outside the 24h window). */
  sendTemplate(
    to: string,
    templateName: string,
    languageCode: string,
    components?: unknown[],
  ): Promise<SendResult> {
    return this.graph.sendTemplate(to, templateName, languageCode, components);
  }

  /** Resolve a media id to a signed URL + MIME. Cached for the wrapper's lifetime. */
  async resolveMedia(mediaId: string): Promise<ResolvedMedia> {
    const cached = this.mediaCache.get(mediaId);
    if (cached) return cached;
    const resolved = await this.graph.resolveMedia(mediaId);
    if (this.mediaCache.size >= DEFAULT_MEDIA_CACHE_SIZE) {
      // Evict the oldest insertion to keep memory bounded for
      // long-running deployments. Insertion-order Map.
      const first = this.mediaCache.keys().next();
      if (!first.done) this.mediaCache.delete(first.value);
    }
    this.mediaCache.set(mediaId, resolved);
    return resolved;
  }

  // ── lifecycle ──────────────────────────────────────────────────────

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    if (this.cacheKey !== undefined) {
      this.refCount -= 1;
      if (this.refCount > 0) return;
      WhatsAppClientWrapper.cache.delete(this.cacheKey);
    }
    this.destroyed = true;
    this.subscribers.clear();
    this.mediaCache.clear();
    if (this.server) {
      try {
        await this.server.close();
      } catch {
        // best-effort
      }
      this.server = undefined;
    }
    this.listening = false;
    this.listenPromise = undefined;
  }

  /** For tests — direct access to the Fastify instance for `inject(...)`. */
  get _app(): FastifyInstance | undefined {
    return this.server;
  }

  /** For tests and diagnostics — current shared-cache ref count. */
  get _refCount(): number {
    return this.refCount;
  }

  /** For tests — has Fastify successfully bound to its port? */
  get _listening(): boolean {
    return this.listening;
  }

  // ── internal payload routing ───────────────────────────────────────

  private async handlePayload(payload: InboundWebhookPayload): Promise<void> {
    const redact = this.options.redactRawText ?? true;
    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value;
        // Status updates are delivery receipts — skip; they're not
        // user-authored messages and inbox consumers don't care.
        if (!value.messages) continue;
        for (const msg of value.messages) {
          await this.dispatchMessage(msg, redact);
        }
      }
    }
  }

  private async dispatchMessage(msg: InboundMessage, redact: boolean): Promise<void> {
    const out: WhatsAppMessage = {
      messageId: msg.id,
      from: msg.from,
      timestamp: parseTimestampMs(msg.timestamp),
      text: this.deriveText(msg, redact),
      raw: msg,
    };
    const media = pickMedia(msg);
    if (media) {
      try {
        const resolved = await this.resolveMedia(media.media.id);
        out.media = { ...resolved, kind: media.kind };
      } catch {
        // Media resolution failure shouldn't drop the message — the
        // placeholder text already tells the agent what kind it was.
      }
    }
    for (const handler of [...this.subscribers]) {
      try {
        await handler(out);
      } catch {
        // Per-handler error doesn't break the dispatcher loop —
        // orchestrator emits typed inbox:error events.
      }
    }
  }

  private deriveText(msg: InboundMessage, redact: boolean): string {
    if (msg.type === "text" && msg.text?.body) {
      return redact ? SecretsManager.redact(msg.text.body) : msg.text.body;
    }
    // Caption-bearing media — surface the caption with a kind marker
    // so the agent has more than `[image]` to work with when present.
    const captioned = msg.image?.caption ?? msg.video?.caption ?? msg.document?.caption;
    if (captioned) {
      const kind = msg.type;
      const cap = redact ? SecretsManager.redact(captioned) : captioned;
      return `[${kind}] ${cap}`;
    }
    return `[${msg.type}]`;
  }
}

function parseTimestampMs(ts: string): number {
  const seconds = Number.parseInt(ts, 10);
  if (!Number.isFinite(seconds)) return Date.now();
  return seconds * 1000;
}

function pickMedia(msg: InboundMessage): { kind: MediaKind; media: InboundMedia } | undefined {
  for (const k of MEDIA_KINDS) {
    const m = msg[k];
    if (m && m.id) return { kind: k, media: m };
  }
  return undefined;
}

/** Score-side options for {@link createWhatsAppClient} / {@link WhatsAppVoice}. */
export interface WhatsAppClientOptions {
  phoneNumberId: string;
  /** Falls back to `WHATSAPP_ACCESS_TOKEN`. */
  accessToken?: string;
  /** Falls back to `WHATSAPP_VERIFY_TOKEN`. */
  verifyToken?: string;
  /** Falls back to `WHATSAPP_APP_SECRET`. */
  appSecret?: string;
  port?: number;
  host?: string;
  graphApiVersion?: string;
  redactRawText?: boolean;
  bodyLimit?: number;
  /**
   * Per-source-IP rate limit at the webhook HTTP boundary. Defaults to
   * 100 req / 60s per IP. Pass `false` to disable when running behind
   * a trusted upstream that already rate-limits.
   */
  rateLimit?: { max?: number; windowMs?: number } | false;
  /** Test-only — injectable fetch for outbound Graph calls. */
  fetchFn?: FetchLike;
}

export type WhatsAppClient =
  | { kind: "ready"; wrapper: WhatsAppClientWrapper }
  | { kind: "missing"; message: string };

export function createWhatsAppClient(options: WhatsAppClientOptions): WhatsAppClient {
  const accessToken = options.accessToken ?? SecretsManager.optional("WHATSAPP_ACCESS_TOKEN");
  if (!accessToken) {
    return {
      kind: "missing",
      message:
        "WhatsApp voice: WHATSAPP_ACCESS_TOKEN is not set. Generate a permanent System User access token in Meta Business → System Users → Generate token (whatsapp_business_messaging + whatsapp_business_management scopes). Temporary 24h tokens work for testing but expire.",
    };
  }
  const verifyToken = options.verifyToken ?? SecretsManager.optional("WHATSAPP_VERIFY_TOKEN");
  if (!verifyToken) {
    return {
      kind: "missing",
      message:
        "WhatsApp voice: WHATSAPP_VERIFY_TOKEN is not set. Pick any random string (e.g. `openssl rand -hex 32`) and configure both this env var AND the matching value in Meta App → WhatsApp → Configuration → Verify token.",
    };
  }
  const appSecret = options.appSecret ?? SecretsManager.optional("WHATSAPP_APP_SECRET");
  if (!appSecret) {
    return {
      kind: "missing",
      message:
        "WhatsApp voice: WHATSAPP_APP_SECRET is not set. Find it in Meta App → Settings → Basic → App Secret. Required to verify HMAC-SHA256 signatures on inbound webhooks; without it, anyone could spoof inbound messages.",
    };
  }
  const wrapperOptions: WhatsAppClientWrapperOptions = {
    phoneNumberId: options.phoneNumberId,
    accessToken,
    verifyToken,
    appSecret,
  };
  if (options.port !== undefined) wrapperOptions.port = options.port;
  if (options.host !== undefined) wrapperOptions.host = options.host;
  if (options.graphApiVersion !== undefined) wrapperOptions.graphApiVersion = options.graphApiVersion;
  if (options.redactRawText !== undefined) wrapperOptions.redactRawText = options.redactRawText;
  if (options.bodyLimit !== undefined) wrapperOptions.bodyLimit = options.bodyLimit;
  if (options.rateLimit !== undefined) wrapperOptions.rateLimit = options.rateLimit;
  if (options.fetchFn !== undefined) wrapperOptions.fetchFn = options.fetchFn;

  const key = WhatsAppClientWrapper.keyFor({ phoneNumberId: options.phoneNumberId });
  return {
    kind: "ready",
    wrapper: WhatsAppClientWrapper.forKey(key, wrapperOptions),
  };
}
