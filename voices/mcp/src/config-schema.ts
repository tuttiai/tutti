import { z } from "zod";

/**
 * Serialisable configuration for the `mcp` voice.
 *
 * `server` is a command line that this voice spawns as a child process.
 * That makes it the highest-privilege field in the whole manifest: it is
 * the one place a stored document names something that will be executed.
 * A builder must treat it as equivalent to granting `shell`, and the
 * manifest marks it so rather than leaving a reader to infer it.
 */
export const McpVoiceConfigSchema = z
  .object({
    server: z
      .string()
      .min(1)
      .describe(
        "MCP server command, e.g. 'npx @playwright/mcp'. EXECUTED AS A CHILD PROCESS. Treat granting this as equivalent to granting shell access.",
      ),
    args: z
      .array(z.string())
      .optional()
      .describe("Additional CLI arguments appended after the server command."),
    env: z
      .record(z.string(), z.string())
      .optional()
      .describe("Extra environment variables passed to the server process."),
    name: z
      .string()
      .min(1)
      .optional()
      .describe("Override the voice name. Defaults to mcp-<server-name>."),
  })
  .strict();

/** Serialisable configuration for the `mcp` voice. */
export type McpVoiceConfig = z.infer<typeof McpVoiceConfigSchema>;
