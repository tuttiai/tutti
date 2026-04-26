import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { PostgresClient } from "../client.js";
import { guardClient } from "../utils/guard.js";
import { postgresErrorMessage } from "../utils/format.js";

const parameters = z.object({
  table: z
    .string()
    .min(1)
    .describe("Table name. Use 'schema.table' to qualify; defaults to schema=public."),
});

interface IndexRow {
  indexname: string;
  indexdef: string;
}

function splitQualified(name: string): { schema: string; table: string } {
  const parts = name.split(".");
  if (parts.length === 1) return { schema: "public", table: parts[0] ?? "" };
  if (parts.length === 2) return { schema: parts[0] ?? "", table: parts[1] ?? "" };
  throw new Error(`Invalid table reference '${name}'. Use 'table' or 'schema.table'.`);
}

export function createListIndexesTool(
  client: PostgresClient,
): Tool<z.infer<typeof parameters>> {
  return {
    name: "list_indexes",
    description: "List indexes on a table with the full CREATE INDEX statement from pg_indexes.",
    parameters,
    execute: async (input) => {
      const blocked = guardClient(client);
      if (blocked) return blocked;
      if (client.kind !== "ready") return { content: "unreachable", is_error: true };

      let qualified: { schema: string; table: string };
      try {
        qualified = splitQualified(input.table);
      } catch (err) {
        return {
          content: err instanceof Error ? err.message : String(err),
          is_error: true,
        };
      }

      try {
        const pool = await client.wrapper.getPool();
        const result = await pool.query<IndexRow>(
          `SELECT indexname, indexdef
           FROM pg_indexes
           WHERE schemaname = $1 AND tablename = $2
           ORDER BY indexname`,
          [qualified.schema, qualified.table],
        );

        if (result.rows.length === 0) {
          return {
            content: `No indexes on '${qualified.schema}.${qualified.table}'.`,
          };
        }

        const header = `${result.rows.length} index${result.rows.length === 1 ? "" : "es"} on ${qualified.schema}.${qualified.table}:`;
        const lines = result.rows.map((r) => `${r.indexname}\n  ${r.indexdef}`);
        return { content: `${header}\n\n${lines.join("\n\n")}` };
      } catch (error) {
        return {
          content: postgresErrorMessage(error, `table ${input.table}`),
          is_error: true,
        };
      }
    },
  };
}
