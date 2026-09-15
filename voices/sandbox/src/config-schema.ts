import { z } from "zod";

/**
 * Serialisable configuration for the `sandbox` voice.
 *
 * This voice requires the `shell` permission. `allowed_languages` and
 * `allowed_packages` narrow what it can do, and both default to
 * unrestricted when omitted, so a builder should present the narrowed form
 * rather than the default.
 */
export const SandboxVoiceConfigSchema = z
  .object({
    allowed_languages: z
      .array(z.enum(["typescript", "python", "bash"]))
      .optional()
      .describe(
        "Restrict which languages the agent may execute. All three are available when omitted.",
      ),
    allowed_packages: z
      .array(z.string().min(1))
      .optional()
      .describe(
        "Package allowlist for install_package. Every package is allowed when omitted.",
      ),
    timeout_ms: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Wall-clock timeout for a code execution. Defaults to 30000."),
    max_file_size_bytes: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Largest file write_file will accept, in bytes. Defaults to 1048576."),
    env: z
      .record(z.string(), z.string())
      .optional()
      .describe("Extra environment variables merged into child process environments."),
    install_timeout_ms: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Timeout for a package install. Defaults to 60000."),
  })
  .strict();

/** Serialisable configuration for the `sandbox` voice. */
export type SandboxVoiceConfig = z.infer<typeof SandboxVoiceConfigSchema>;
