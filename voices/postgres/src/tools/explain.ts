import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { PostgresClient, PostgresClientLike } from "../client.js";
import { guardClient } from "../utils/guard.js";
import { postgresErrorMessage } from "../utils/format.js";

const parameters = z.object({
  sql: z
    .string()
    .min(1)
    .describe("SQL statement to explain. Bind params with $1, $2, ..."),
  params: z
    .array(z.unknown())
    .max(100)
    .default([])
    .describe("Bind parameters for the SQL placeholders."),
  analyze: z
    .boolean()
    .default(false)
    .describe(
      "If true, actually execute the query and return real timings. EXPLAIN ANALYZE for SELECT runs the query (read-only); on writes Postgres will reject inside our READ ONLY transaction.",
    ),
});

interface PlanRow {
  "QUERY PLAN": string;
}

export function createExplainTool(client: PostgresClient): Tool<z.infer<typeof parameters>> {
  return {
    name: "explain",
    description:
      "Run EXPLAIN (or EXPLAIN ANALYZE) on a query inside a BEGIN READ ONLY transaction. Returns the planner output line by line.",
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
          const prefix = input.analyze
            ? "EXPLAIN (ANALYZE, BUFFERS, VERBOSE) "
            : "EXPLAIN (VERBOSE) ";
          const result = await conn.query<PlanRow>(prefix + input.sql, input.params);
          await conn.query("ROLLBACK");
          const lines = result.rows.map((r) => r["QUERY PLAN"]);
          return { content: lines.join("\n") };
        } catch (queryError) {
          try {
            await conn.query("ROLLBACK");
          } catch {
            // ignore — surface original
          }
          throw queryError;
        }
      } catch (error) {
        return { content: postgresErrorMessage(error, "explain"), is_error: true };
      } finally {
        if (conn) conn.release();
      }
    },
  };
}
