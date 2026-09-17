import { z } from "zod";

/** Serialisable configuration for the `playwright` voice. */
export const PlaywrightVoiceConfigSchema = z
  .object({
    headless: z
      .boolean()
      .optional()
      .describe("Run the browser in headless mode. Defaults to true."),
    slowMo: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("Milliseconds to wait between actions. For debugging only."),
    timeout: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Default action timeout in milliseconds. Defaults to 10000."),
  })
  .strict();

/** Serialisable configuration for the `playwright` voice. */
export type PlaywrightVoiceConfig = z.infer<typeof PlaywrightVoiceConfigSchema>;
