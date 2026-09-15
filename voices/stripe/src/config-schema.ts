import { z } from "zod";

/**
 * Serialisable configuration for the `stripe` voice.
 *
 * `clientFactory` on {@link StripeVoiceOptions} is a test seam and is
 * deliberately not expressible here.
 */
export const StripeVoiceConfigSchema = z
  .object({
    api_key: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Stripe secret API key (sk_test_... or sk_live_...). Falls back to the STRIPE_SECRET_KEY environment variable. Every destructive tool in this voice moves real money on a live key.",
      ),
  })
  .strict();

/** Serialisable configuration for the `stripe` voice. */
export type StripeVoiceConfig = z.infer<typeof StripeVoiceConfigSchema>;
