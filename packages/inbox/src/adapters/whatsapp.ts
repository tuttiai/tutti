// Type-only import — does not require @tuttiai/whatsapp to be
// installed at compile time as a hard dependency. The runtime import
// below performs the actual lazy load; consumers that don't use the
// WhatsApp adapter never trigger it.
import type {
  FetchLike,
  WhatsAppClientWrapper,
  WhatsAppMessage,
} from "@tuttiai/whatsapp";
import type { InboxAdapter, InboxMessage, InboxMessageHandler, InboxReply } from "../types.js";

export interface WhatsAppInboxAdapterOptions {
  /** Meta-assigned phone number id (cache key for the shared wrapper). */
  phoneNumberId: string;
  /** Webhook listener port. Default 3848. */
  port?: number;
  /** Webhook listener bind address. Default `0.0.0.0`. */
  host?: string;
  /** Graph API version. Default `v21.0`. */
  graphApiVersion?: string;
  /** Body limit on the webhook endpoint. Default 5 MB. */
  bodyLimit?: number;
  /** Run SecretsManager.redact on dispatched text. Default true. */
  inboxRedactRawText?: boolean;
  /** Test-only — injectable fetch for outbound Graph calls. */
  fetchFn?: FetchLike;
}

/**
 * Inbox adapter for WhatsApp via Meta's Cloud API + a self-hosted
 * Fastify webhook server. Dynamic-imports `@tuttiai/whatsapp` so the
 * package is an OPTIONAL peer dependency — consumers that don't use
 * the WhatsApp adapter never pay the install cost.
 *
 * Operationally distinct from the other adapters: WhatsApp REQUIRES a
 * public HTTPS endpoint Meta can POST to. The wrapper opens a Fastify
 * server on the configured port (default 3848) hosting `GET /webhook`
 * (verify handshake) and `POST /webhook` (signed inbound messages).
 * The operator must front it with a tunnel (Cloudflare Tunnel / ngrok
 * / their own reverse proxy) and point the Meta App's Callback URL
 * at the tunnel.
 *
 * Secrets resolve via the voice's `createWhatsAppClient` from
 * `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`
 * — the score never carries them.
 *
 * Media: in v0.25 inbound media (image / audio / video / document)
 * surfaces as a placeholder text (`[image]` etc., or `[image] caption`
 * when present) with the resolved URL on `InboxMessage.raw`. A typed
 * `attachments` field on `InboxMessage` is deferred to a deliberate
 * cross-platform design pass.
 */
export class WhatsAppInboxAdapter implements InboxAdapter {
  readonly platform = "whatsapp" as const;
  private wrapper?: WhatsAppClientWrapper;
  private unsubscribe?: () => void;
  private started = false;

  constructor(private readonly options: WhatsAppInboxAdapterOptions) {}

  async start(handler: InboxMessageHandler): Promise<void> {
    if (this.started) return;
    const mod = await loadWhatsAppModule();
    const clientOptions: import("@tuttiai/whatsapp").WhatsAppClientOptions = {
      phoneNumberId: this.options.phoneNumberId,
    };
    if (this.options.port !== undefined) clientOptions.port = this.options.port;
    if (this.options.host !== undefined) clientOptions.host = this.options.host;
    if (this.options.graphApiVersion !== undefined) {
      clientOptions.graphApiVersion = this.options.graphApiVersion;
    }
    if (this.options.bodyLimit !== undefined) clientOptions.bodyLimit = this.options.bodyLimit;
    if (this.options.inboxRedactRawText !== undefined) {
      clientOptions.redactRawText = this.options.inboxRedactRawText;
    }
    if (this.options.fetchFn !== undefined) clientOptions.fetchFn = this.options.fetchFn;

    const client = mod.createWhatsAppClient(clientOptions);
    if (client.kind !== "ready") {
      throw new Error(`WhatsAppInboxAdapter: ${client.message}`);
    }
    this.wrapper = client.wrapper;

    this.unsubscribe = this.wrapper.subscribeMessage(async (msg) => {
      const im = whatsappMessageToInboxMessage(msg);
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
      throw new Error("WhatsAppInboxAdapter.send called before start().");
    }
    if (reply.text.length === 0) return;
    // chat_id IS the sender's E.164 number — DMs only on Cloud API.
    await this.wrapper.sendText(chat_id, reply.text);
  }
}

function whatsappMessageToInboxMessage(msg: WhatsAppMessage): InboxMessage {
  return {
    platform: "whatsapp",
    platform_user_id: msg.from,
    // chat_id == from for WhatsApp Cloud API: groups aren't supported
    // for two-way bots, so every conversation is a 1:1 between the bot
    // and the user. The user's E.164 number doubles as the conversation
    // identifier.
    platform_chat_id: msg.from,
    text: msg.text,
    timestamp: msg.timestamp,
    raw: msg,
  };
}

let cachedModule: typeof import("@tuttiai/whatsapp") | undefined;

async function loadWhatsAppModule(): Promise<typeof import("@tuttiai/whatsapp")> {
  if (cachedModule) return cachedModule;
  try {
    cachedModule = await import("@tuttiai/whatsapp");
    return cachedModule;
  } catch (err) {
    throw new Error(
      "WhatsAppInboxAdapter: @tuttiai/whatsapp is not installed. Run `npm install @tuttiai/whatsapp` (or `tutti-ai add whatsapp`) and try again. " +
        `Underlying error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
