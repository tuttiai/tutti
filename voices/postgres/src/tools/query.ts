import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { PostgresClient, PostgresClientLike } from "../client.js";
import { guardClient } from "../utils/guard.js";
import { formatNumber, formatTable, postgresErrorMessage } from "../utils/format.js";

const parameters = z.object({
  sql: z
    .string()
    .min(1)
    .describe(
      "SQL to run. Wrapped in BEGIN READ ONLY ... ROLLBACK so write statements are rejected by the server with SQLSTATE 25006. Use $1, $2, ... for parameters.",
    ),
  params: z
    .array(z.unknown())
    .max(100)
    .default([])
    .describe(
      "Bind parameters for the SQL placeholders. Always use these instead of string-concatenating values to avoid SQL injection.",
    ),
  max_rows: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .default(100)
    .describe("Truncate the result set after this many rows (max 1000)."),
});

const MAX_RESULT_CHARS = 8_000;

export function createQueryTool(client: PostgresClient): Tool<z.infer<typeof parameters>> {
  return {
    name: "query",
    description:
      "Run a read-only SQL query. The statement is executed inside a BEGIN READ ONLY transaction so any INSERT/UPDATE/DELETE/DDL is rejected by Postgres itself, even if the calling role has write privileges. Returns rows as a fixed-width text table.",
    parameters,
    execute: async (input) => {
      const blocked = guardClient(client);
      if (blocked) return blocked;
      if (client.kind !== "ready") return { content: "unreachable", is_error: true };

      let conn: PostgresClientLike | undefined;
      try {
        const pool = await client.wrapper.getPool();
        conn = await pool.connect();
        await conn.query("BEGIN READ ONLY");
        try {
          const result = await conn.query(input.sql, input.params);
          await conn.query("ROLLBACK");
          const truncated = result.rows.slice(0, input.max_rows);
          const columns = (result.fields ?? []).map((f) => f.name);
          const table = formatTable(columns, truncated);
          const truncatedNote =
            result.rows.length > truncated.length
              ? ` (truncated from ${formatNumber(result.rows.length)})`
              : "";
          const header = `${formatNumber(truncated.length)} row${truncated.length === 1 ? "" : "s"}${truncatedNote}`;
          let content = `${header}\n\n${table}`;
          if (content.length > MAX_RESULT_CHARS) {
            content =
              content.slice(0, MAX_RESULT_CHARS) +
              `\n\n[result truncated at ${formatNumber(MAX_RESULT_CHARS)} chars; reduce max_rows or narrow the SELECT]`;
          }
          return { content };
        } catch (queryError) {
          // Best-effort cleanup; if ROLLBACK itself fails we still surface
          // the original error rather than the cleanup failure.
          try {
            await conn.query("ROLLBACK");
          } catch {
            // ignore — the original error is more useful
          }
          throw queryError;
        }
      } catch (error) {
        return { content: postgresErrorMessage(error, "query"), is_error: true };
      } finally {
        if (conn) conn.release();
      }
    },
  };
}
