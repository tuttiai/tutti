/**
 * Narrow shapes of the inbound WhatsApp Cloud API webhook payload
 * we read. Meta's actual payload is far wider — we only declare the
 * fields the wrapper inspects, and stash the original on `raw` for
 * downstream consumers.
 *
 * Reference: <https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/payload-examples>
 */

/** Inbound message types we surface. Other types (sticker, location, …) are dropped in v0.25. */
export type InboundMessageType = "text" | "image" | "audio" | "video" | "document";

/** Single media reference inside a message, e.g. `image: { id, mime_type, ... }`. */
export interface InboundMedia {
  id: string;
  mime_type?: string;
  sha256?: string;
  caption?: string;
}

/** Single inbound message inside a webhook envelope. */
export interface InboundMessage {
  /** E.164 phone number of the sender, no leading `+`. */
  from: string;
  /** wamid — WhatsApp message id. */
  id: string;
  /** Unix-second timestamp as a string (Meta's choice). */
  timestamp: string;
  type: string;
  text?: { body: string };
  image?: InboundMedia;
  audio?: InboundMedia;
  video?: InboundMedia;
  document?: InboundMedia;
}

/** Status update — delivery receipts. We ignore these in v0.25. */
export interface InboundStatus {
  id: string;
  status: "sent" | "delivered" | "read" | "failed";
  timestamp: string;
  recipient_id: string;
}

/** `value` block inside a webhook change. */
export interface InboundChangeValue {
  messaging_product: "whatsapp";
  metadata?: {
    display_phone_number?: string;
    phone_number_id?: string;
  };
  contacts?: Array<{ profile?: { name?: string }; wa_id?: string }>;
  messages?: InboundMessage[];
  statuses?: InboundStatus[];
}

export interface InboundChange {
  value: InboundChangeValue;
  field: string;
}

export interface InboundEntry {
  id: string;
  changes: InboundChange[];
}

export interface InboundWebhookPayload {
  object: "whatsapp_business_account";
  entry: InboundEntry[];
}
