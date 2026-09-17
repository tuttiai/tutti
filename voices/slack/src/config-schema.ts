import { z } from "zod";

/**
 * Serialisable configuration for the `slack` voice.
 *
 * `clientFactory` on {@link SlackVoiceOptions} is a test seam and is
 * deliberately not expressible here: a stored document may not name a
 * function.
 */
export const SlackVoiceConfigSchema = z
  .object({
    token: z
      .string()
      .min(1)
      .optional()
      .describe("Slack bot token (xoxb-...). Falls back to the SLACK_BOT_TOKEN environment variable."),
  })
  .strict();

/** Serialisable configuration for the `slack` voice. */
export type SlackVoiceConfig = z.infer<typeof SlackVoiceConfigSchema>;
