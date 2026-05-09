/**
 * Thin HTTP client over Meta's WhatsApp Cloud API (Graph API). Plain
 * `fetch` — no SDK — which keeps the dep tree small and avoids the
 * churn that comes with the official Meta SDK's frequent breaks.
 *
 * Two error paths matter for v0.25:
 * - 131047 ("Re-engagement message") — outbound message outside the
 *   24-hour customer-service window. Free-form replies are only
 *   permitted for 24h after the user's last inbound. Outside that
 *   window, only pre-approved Message Templates work.
 * - Anything else — surface the Meta error code and message verbatim
 *   so the user can debug.
 */

/** Injectable fetch-like; defaults to globalThis.fetch (Node 20+). */
export type FetchLike = (input: string, init?: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

/** Meta Graph API error envelope. */
export interface MetaApiError {
  message: string;
  code: number;
  type?: string;
  fbtrace_id?: string;
  error_subcode?: number;
  error_data?: { details?: string };
}

/** Specialised Error for Meta API failures. Exposes the parsed code. */
export class WhatsAppApiError extends Error {
  readonly code: number;
  readonly subcode?: number;

  constructor(metaError: MetaApiError) {
    const subcodeText = metaError.error_subcode !== undefined ? `/${metaError.error_subcode}` : "";
    super(`WhatsApp API error [${metaError.code}${subcodeText}]: ${metaError.message}`);
    this.name = "WhatsAppApiError";
    this.code = metaError.code;
    if (metaError.error_subcode !== undefined) this.subcode = metaError.error_subcode;
  }

  /** True when the failure is the "outside 24h customer-service window" error. */
  get isReengagementWindowExpired(): boolean {
    return this.code === 131047;
  }
}

export interface GraphClientOptions {
  phoneNumberId: string;
  accessToken: string;
  graphApiVersion?: string;
  fetchFn?: FetchLike;
}

export interface ResolvedMedia {
  url: string;
  mimeType: string;
  sha256?: string;
  fileSize?: number;
}

export interface SendResult {
  /** wamid — WhatsApp Message ID, returned by the Cloud API. */
  messageId: string;
}

/**
 * Issue requests against the WhatsApp Cloud API. Each instance is
 * configured for one phone number (one bot identity); the inbox
 * adapter and the voice's outbound tools share an instance via the
 * wrapper's `forKey` cache.
 */
export class GraphClient {
  private readonly base: string;
  private readonly fetchFn: FetchLike;

  constructor(private readonly options: GraphClientOptions) {
    const v = options.graphApiVersion ?? "v21.0";
    this.base = `https://graph.facebook.com/${v}`;
    // Cast through unknown — globalThis.fetch's full Response type is
    // wider than we narrow; we only touch ok/status/statusText/json/text.
    this.fetchFn = (options.fetchFn ?? (globalThis.fetch as unknown as FetchLike));
  }

  /** Send a free-form text message. Only valid within the 24h window. */
  async sendText(to: string, text: string): Promise<SendResult> {
    return this.postMessages({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    });
  }

  /**
   * Send a pre-approved Message Template. Required for outbound
   * messages outside the 24h customer-service window. Templates are
   * registered + approved per-template in the Meta App dashboard.
   */
  async sendTemplate(
    to: string,
    templateName: string,
    languageCode: string,
    components?: unknown[],
  ): Promise<SendResult> {
    return this.postMessages({
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name: templateName,
        language: { code: languageCode },
        ...(components !== undefined ? { components } : {}),
      },
    });
  }

  /**
   * Resolve a media id (from an inbound message) to a short-lived
   * signed download URL + MIME type. The URL itself requires the
   * bearer token to actually fetch the bytes; this method only
   * returns the metadata.
   */
  async resolveMedia(mediaId: string): Promise<ResolvedMedia> {
    const res = await this.fetchFn(`${this.base}/${encodeURIComponent(mediaId)}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${this.options.accessToken}` },
    });
    if (!res.ok) await this.throwApiError(res);
    const body = (await res.json()) as {
      url?: string;
      mime_type?: string;
      sha256?: string;
      file_size?: number;
    };
    if (!body.url || !body.mime_type) {
      throw new Error(`Media ${mediaId}: Graph API returned no url/mime_type.`);
    }
    const out: ResolvedMedia = { url: body.url, mimeType: body.mime_type };
    if (body.sha256 !== undefined) out.sha256 = body.sha256;
    if (body.file_size !== undefined) out.fileSize = body.file_size;
    return out;
  }

  private async postMessages(payload: unknown): Promise<SendResult> {
    const res = await this.fetchFn(
      `${this.base}/${encodeURIComponent(this.options.phoneNumberId)}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.options.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      },
    );
    if (!res.ok) await this.throwApiError(res);
    const body = (await res.json()) as {
      messages?: Array<{ id?: string }>;
    };
    const messageId = body.messages?.[0]?.id;
    if (!messageId) {
      throw new Error("WhatsApp send: Graph API returned no message id (unexpected shape).");
    }
    return { messageId };
  }

  private async throwApiError(res: { status: number; statusText: string; json(): Promise<unknown>; text(): Promise<string> }): Promise<never> {
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      const txt = await res.text().catch(() => "");
      throw new Error(`WhatsApp API HTTP ${res.status} ${res.statusText}: ${txt.slice(0, 500)}`);
    }
    const error = (parsed as { error?: MetaApiError }).error;
    if (error) throw new WhatsAppApiError(error);
    throw new Error(`WhatsApp API HTTP ${res.status} ${res.statusText}: ${JSON.stringify(parsed).slice(0, 500)}`);
  }
}
