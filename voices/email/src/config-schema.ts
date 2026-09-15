import { z } from "zod";

/** IMAP or SMTP endpoint. Shared shape, different defaults for `secure`. */
const MailEndpointSchema = z.object({
  host: z.string().min(1).describe("Server hostname."),
  port: z.number().int().positive().max(65535).describe("Server port."),
  user: z.string().min(1).describe("Account username."),
  password: z
    .string()
    .min(1)
    .optional()
    .describe("Account password. Falls back to the protocol-specific environment variable, then TUTTI_EMAIL_PASSWORD."),
  secure: z
    .boolean()
    .optional()
    .describe(
      "TLS preference. IMAP defaults to true, matching port 993. SMTP depends on the port: 465 is true, 587 and 25 are false and use STARTTLS.",
    ),
});

/**
 * Serialisable configuration for the `email` voice.
 *
 * `_imapFactory` on {@link EmailVoiceOptions} is a test seam and is
 * deliberately not expressible here.
 */
export const EmailVoiceConfigSchema = z
  .object({
    imap: MailEndpointSchema.describe("Inbound IMAP endpoint."),
    smtp: MailEndpointSchema.describe("Outbound SMTP endpoint."),
    from: z
      .string()
      .min(1)
      .describe('Default From header on outbound mail, e.g. "Tutti Bot <bot@example.com>".'),
    maxBodyChars: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Character limit on an inbound text body. Defaults to 1000000, roughly 1 MB."),
    redactRawText: z
      .boolean()
      .optional()
      .describe("Run SecretsManager.redact on dispatched text. Defaults to true."),
  })
  .strict();

/** Serialisable configuration for the `email` voice. */
export type EmailVoiceConfig = z.infer<typeof EmailVoiceConfigSchema>;
