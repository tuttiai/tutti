import { z } from "zod";

/**
 * Serialisable configuration for the `twitter` voice.
 *
 * Read access needs `bearer_token`. Write access needs all four OAuth 1.0a
 * values. The dependency between them is a cross-field rule that a JSON
 * Schema manifest cannot carry, so it is enforced here and named in the
 * manifest's `x-tutti-cross-field` note rather than silently lost.
 */
export const TwitterVoiceConfigSchema = z
  .object({
    bearer_token: z
      .string()
      .min(1)
      .optional()
      .describe("App-only bearer token. Grants read-only access to the v2 API."),
    api_key: z
      .string()
      .min(1)
      .optional()
      .describe("OAuth 1.0a app consumer key. Required for write operations."),
    api_secret: z
      .string()
      .min(1)
      .optional()
      .describe("OAuth 1.0a app consumer secret. Required for write operations."),
    access_token: z
      .string()
      .min(1)
      .optional()
      .describe("OAuth 1.0a user access token. Required for write operations."),
    access_token_secret: z
      .string()
      .min(1)
      .optional()
      .describe("OAuth 1.0a user access token secret. Required for write operations."),
  })
  .strict()
  .refine(
    (c) => {
      const write = [c.api_key, c.api_secret, c.access_token, c.access_token_secret];
      const set = write.filter((v) => v !== undefined).length;
      return set === 0 || set === 4;
    },
    {
      message:
        "twitter: write access needs all four of api_key, api_secret, access_token and access_token_secret, or none of them",
    },
  );

/** Serialisable configuration for the `twitter` voice. */
export type TwitterVoiceConfig = z.infer<typeof TwitterVoiceConfigSchema>;
