import { z } from "zod";

/**
 * Serialisable configuration for the `telegram` voice.
 *
 * `clientFactory` on {@link TelegramVoiceOptions} is a test seam and is
 * deliberately not expressible here.
 */
export const TelegramVoiceConfigSchema = z
  .object({
    token: z
      .string()
      .min(1)
      .optional()
      .describe("Telegram bot token. Falls back to the TELEGRAM_BOT_TOKEN environment variable."),
  })
  .strict();

/** Serialisable configuration for the `telegram` voice. */
export type TelegramVoiceConfig = z.infer<typeof TelegramVoiceConfigSchema>;
