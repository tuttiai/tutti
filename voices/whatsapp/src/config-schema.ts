import { z } from "zod";

/**
 * Serialisable configuration for the `whatsapp` voice.
 *
 * `fetchFn` on {@link WhatsAppVoiceOptions} is a test seam and is
 * deliberately not expressible here.
 */
export const WhatsAppVoiceConfigSchema = z
  .object({
    phoneNumberId: z.string().min(1).describe("WhatsApp Business phone number ID. Required."),
    accessToken: z
      .string()
      .min(1)
      .optional()
      .describe("Graph API access token. Falls back to WHATSAPP_ACCESS_TOKEN."),
    verifyToken: z
      .string()
      .min(1)
      .optional()
      .describe("Webhook verification token. Falls back to WHATSAPP_VERIFY_TOKEN."),
    appSecret: z
      .string()
      .min(1)
      .optional()
      .describe("App secret used to verify webhook signatures. Falls back to WHATSAPP_APP_SECRET."),
    port: z.number().int().positive().max(65535).optional().describe("Webhook server port."),
    host: z.string().min(1).optional().describe("Webhook server bind host."),
    graphApiVersion: z.string().min(1).optional().describe("Graph API version, e.g. v21.0."),
    redactRawText: z
      .boolean()
      .optional()
      .describe("Run SecretsManager.redact on dispatched text."),
    bodyLimit: z.number().int().positive().optional().describe("Maximum webhook request body size in bytes."),
    rateLimit: z
      .union([
        z
          .object({
            max: z.number().int().positive().optional().describe("Requests permitted per window."),
            windowMs: z.number().int().positive().optional().describe("Window length in milliseconds."),
          })
          .strict(),
        z.literal(false),
      ])
      .optional()
      .describe(
        "Per-source-IP rate limit at the webhook boundary. Defaults to 100 requests per 60s per IP. Pass false only behind a trusted upstream that already rate-limits.",
      ),
  })
  .strict();

/** Serialisable configuration for the `whatsapp` voice. */
export type WhatsAppVoiceConfig = z.infer<typeof WhatsAppVoiceConfigSchema>;
