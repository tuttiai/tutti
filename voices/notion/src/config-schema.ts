import { z } from "zod";

/**
 * Serialisable configuration for the `notion` voice.
 *
 * The `fetch` a test passes to {@link NotionVoice} is a test seam and is
 * deliberately not expressible here.
 */
export const NotionVoiceConfigSchema = z
  .object({
    token: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Notion internal integration secret (ntn_... or secret_...). Falls back to the NOTION_TOKEN environment variable. The voice sees only the pages and databases shared with that integration.",
      ),
  })
  .strict();

/** Serialisable configuration for the `notion` voice. */
export type NotionVoiceConfig = z.infer<typeof NotionVoiceConfigSchema>;
