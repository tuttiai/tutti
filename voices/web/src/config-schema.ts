import { z } from "zod";

/**
 * Serialisable configuration for the `web` voice.
 *
 * {@link WebVoiceConfig} also accepts a `SearchProvider` instance for
 * `provider`. That is a live object, so only the three named providers are
 * expressible in a stored document.
 */
export const WebVoiceConfigSchema = z
  .object({
    provider: z
      .enum(["brave", "serper", "duckduckgo"])
      .optional()
      .describe(
        "Search provider. When omitted the voice auto-selects from the available API keys, preferring Brave, then Serper, then DuckDuckGo.",
      ),
    cache: z
      .boolean()
      .optional()
      .describe("Enable the LRU result cache. Defaults to true. Disable when freshness matters more than latency."),
    max_results: z
      .number()
      .int()
      .min(1)
      .max(20)
      .optional()
      .describe("Default number of results from web_search. The agent may still override per call. Defaults to 5."),
    rate_limit: z
      .object({
        per_minute: z.number().int().positive().describe("Calls permitted per minute."),
      })
      .strict()
      .optional()
      .describe("Per-tool rate limit shared by every tool in the voice."),
    timeout_ms: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("HTTP request timeout in milliseconds. Defaults to 5000."),
  })
  .strict();

/** Serialisable configuration for the `web` voice. */
export type WebVoiceConfigSerialisable = z.infer<typeof WebVoiceConfigSchema>;
