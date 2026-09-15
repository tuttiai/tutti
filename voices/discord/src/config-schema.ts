import { z } from "zod";

/**
 * Serialisable configuration for the `discord` voice.
 *
 * `clientFactory` on {@link DiscordVoiceOptions} is a test seam and is
 * deliberately not expressible here.
 */
export const DiscordVoiceConfigSchema = z
  .object({
    token: z
      .string()
      .min(1)
      .optional()
      .describe("Discord bot token. Falls back to the DISCORD_BOT_TOKEN environment variable."),
  })
  .strict();

/** Serialisable configuration for the `discord` voice. */
export type DiscordVoiceConfig = z.infer<typeof DiscordVoiceConfigSchema>;
