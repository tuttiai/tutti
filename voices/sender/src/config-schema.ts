import { z } from "zod";

/**
 * Serialisable configuration for the `sender` voice.
 *
 * `fetch` on {@link SenderVoiceOptions} is a test seam and is deliberately
 * not expressible here.
 */
export const SenderVoiceConfigSchema = z
  .object({
    api_key: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Sender API access token (Settings > API access tokens). Falls back to the SENDER_API_KEY environment variable. send_campaign emails real subscribers and cannot be undone.",
      ),
  })
  .strict();

/** Serialisable configuration for the `sender` voice. */
export type SenderVoiceConfig = z.infer<typeof SenderVoiceConfigSchema>;
