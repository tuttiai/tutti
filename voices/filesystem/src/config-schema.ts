import { z } from "zod";

/**
 * Serialisable configuration for the `filesystem` voice.
 *
 * The voice takes no configuration. The empty strict object is deliberate
 * rather than an omission: it states that any key on this voice's `options`
 * is a mistake, and the manifest carries that as `additionalProperties:
 * false` so a builder can refuse one before deployment.
 */
export const FilesystemVoiceConfigSchema = z.object({}).strict();

/** Serialisable configuration for the `filesystem` voice. */
export type FilesystemVoiceConfig = z.infer<typeof FilesystemVoiceConfigSchema>;
