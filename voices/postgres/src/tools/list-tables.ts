import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { PostgresClient } from "../client.js";
import { guardClient } from "../utils/guard.js";
import { formatNumber, postgresErrorMessage } from "../utils/format.js";

const parameters = z.object({
  schema: z
    .string()
    .min(1)
    .default("public")
    .describe("Schema name to list tables from. Defaults to 'public'."),
  include_views: z.boolean().default(true).describe("Include views in the listing"),
});

interface TableRow {
  table_schema: string;
  table_name: string;
  table_type: string;
  approximate_row_count: string | null;
}

export function createListTablesTool(
  client: PostgresClient,
): Tool<z.infer<typeof parameters>> {
  return {
    name: "list_tables",
    description:
      "List tables (and optionally views) in a schema with type and approximate row count from pg_class.reltuples.",
    parameters,
    execute: async (input) => {
      const blocked = guardClient(client);
      if (blocked) return blocked;
      if (client.kind !== "ready") return { content: "unreachable", is_error: true };

      try {
        const pool = await client.wrapper.getPool();
        // Schema name passed as a parameter — never interpolated.
        const types = input.include_views
          ? ["BASE TABLE", "VIEW"]
          : ["BASE TABLE"];
        const result = await pool.query<TableRow>(
          `SELECT t.table_schema,
                  t.table_name,
                  t.table_type,
                  COALESCE(c.reltuples::bigint, 0)::text AS approximate_row_count
           FROM information_schema.tables t
           LEFT JOIN pg_class c
             ON c.relname = t.table_name
            AND c.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = t.table_schema)
           WHERE t.table_schema = $1
             AND t.table_type = ANY($2)
           ORDER BY t.table_name`,
          [input.schema, types],
        );

        if (result.rows.length === 0) {
          return { content: `No tables in schema '${input.schema}'.` };
        }

        const header = `${result.rows.length} table${
          result.rows.length === 1 ? "" : "s"
        } in '${input.schema}':`;
        const lines = result.rows.map((r) => {
          const typeLabel = r.table_type === "VIEW" ? "view" : "table";
          const rowCount = r.approximate_row_count
            ? ` ~${formatNumber(Number(r.approximate_row_count))} rows`
            : "";
          return `${r.table_name} (${typeLabel})${rowCount}`;
        });
        return { content: `${header}\n\n${lines.join("\n")}` };
      } catch (error) {
        return {
          content: postgresErrorMessage(error, `schema ${input.schema}`),
          is_error: true,
        };
      }
    },
  };
}
