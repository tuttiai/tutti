import type { Permission, Tool, Voice } from "@tuttiai/types";
import {
  createWhatsAppClient,
  type WhatsAppClient,
  type WhatsAppClientOptions,
} from "./client.js";
import { createSendTextMessageTool } from "./tools/send-text-message.js";
import { createSendTemplateMessageTool } from "./tools/send-template-message.js";

export type WhatsAppVoiceOptions = WhatsAppClientOptions;

/**
 * Gives agents the ability to send WhatsApp messages via Meta's
 * Cloud API. Two tools, both `destructive: true`:
 * - `send_text_message` — free-form text, valid within the 24h
 *   customer-service window.
 * - `send_template_message` — pre-approved Message Templates, the
 *   only path for re-engagement outside the 24h window.
 *
 * Inbound (webhooks) is handled through the wrapper's
 * {@link WhatsAppClientWrapper.subscribeMessage}, which
 * `@tuttiai/inbox`'s WhatsApp adapter consumes. The shared
 * {@link WhatsAppClientWrapper.forKey} cache (keyed by
 * `phoneNumberId`) ensures the voice and the inbox adapter share one
 * Fastify webhook server and one Graph API client per bot identity.
 *
 * Operationally, the webhook server binds to a configured port
 * (default 3848) and the operator must run a tunnel (Cloudflare
 * Tunnel / ngrok / their own reverse proxy) so Meta can reach it.
 */
export class WhatsAppVoice implements Voice {
  name = "whatsapp";
  description = "Send WhatsApp messages via Meta's Cloud API";
  required_permissions: Permission[] = ["network"];
  tools: Tool[];

  private readonly client: WhatsAppClient;

  constructor(options: WhatsAppVoiceOptions) {
    this.client = createWhatsAppClient(options);
    this.tools = [
      createSendTextMessageTool(this.client),
      createSendTemplateMessageTool(this.client),
    ];
  }

  async teardown(): Promise<void> {
    if (this.client.kind === "ready") {
      await this.client.wrapper.destroy();
    }
  }
}

export {
  WhatsAppClientWrapper,
  createWhatsAppClient,
  DEFAULT_MEDIA_CACHE_SIZE,
} from "./client.js";
export type {
  WhatsAppClient,
  WhatsAppClientOptions,
  WhatsAppClientWrapperOptions,
  WhatsAppMessage,
  WhatsAppMessageHandler,
} from "./client.js";
export {
  GraphClient,
  WhatsAppApiError,
} from "./graph-client.js";
export type {
  FetchLike,
  GraphClientOptions,
  MetaApiError,
  ResolvedMedia,
  SendResult,
} from "./graph-client.js";
export { verifyMetaSignature } from "./signature.js";
export { buildWebhookServer } from "./server.js";
export type { WebhookHandler, WebhookServerOptions } from "./server.js";
export type {
  InboundMessageType,
  InboundMedia,
  InboundMessage,
  InboundStatus,
  InboundChange,
  InboundChangeValue,
  InboundEntry,
  InboundWebhookPayload,
} from "./types.js";
