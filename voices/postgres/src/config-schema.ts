import { z } from "zod";

/**
 * Serialisable configuration for the `postgres` voice.
 *
 * `poolFactory` on {@link PostgresVoiceOptions} is a test seam and is
 * deliberately not expressible here.
 */
export const PostgresVoiceConfigSchema = z
  .object({
    connection_string: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Postgres connection string, e.g. postgres://user:pass@host:5432/db. Falls back to DATABASE_URL, then POSTGRES_URL.",
      ),
    statement_timeout_ms: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Per-statement timeout enforced server-side, stopping a runaway query from hanging the agent. Defaults to 30000.",
      ),
    max_connections: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Maximum simultaneous connections in the pool. Defaults to 5, because agents typically run sequential queries and managed Postgres caps connections aggressively.",
      ),
  })
  .strict();

/** Serialisable configuration for the `postgres` voice. */
export type PostgresVoiceConfig = z.infer<typeof PostgresVoiceConfigSchema>;
