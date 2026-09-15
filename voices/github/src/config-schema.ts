import { z } from "zod";

/**
 * Serialisable configuration for the `github` voice.
 *
 * This is the subset of {@link GitHubVoiceOptions} that a stored graph
 * document may carry. Runtime-only injection points — test factories and
 * callbacks — are deliberately absent, because a document that named a
 * function would require that function to be evaluated, and "no
 * customer-supplied string is ever evaluated" is a platform invariant.
 *
 * Every field carries `.describe()` so the generated manifest is
 * self-documenting. See `scripts/build-voice-manifest.mjs`.
 */
export const GitHubVoiceConfigSchema = z
  .object({
    token: z
      .string()
      .min(1)
      .optional()
      .describe("GitHub personal access token. Falls back to the GITHUB_TOKEN environment variable."),
  })
  .strict();

/** Serialisable configuration for the `github` voice. */
export type GitHubVoiceConfig = z.infer<typeof GitHubVoiceConfigSchema>;
