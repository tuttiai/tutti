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

interface ColumnRow {
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
  character_maximum_length: number | null;
  numeric_precision: number | null;
  numeric_scale: number | null;
  is_primary_key: boolean;
}

function splitQualified(name: string): { schema: string; table: string } {
  const parts = name.split(".");
  if (parts.length === 1) return { schema: "public", table: parts[0] ?? "" };
  if (parts.length === 2) return { schema: parts[0] ?? "", table: parts[1] ?? "" };
  throw new Error(
    `Invalid table reference '${name}'. Use 'table' or 'schema.table'.`,
  );
}

function fullType(row: ColumnRow): string {
  const t = row.data_type;
  if (row.character_maximum_length) return `${t}(${row.character_maximum_length})`;
  if (row.numeric_precision && row.numeric_scale != null) {
    return `${t}(${row.numeric_precision},${row.numeric_scale})`;
  }
  if (row.numeric_precision) return `${t}(${row.numeric_precision})`;
  return t;
}

export function createDescribeTableTool(
  client: PostgresClient,
): Tool<z.infer<typeof parameters>> {
  return {
    name: "describe_table",
    description:
      "Show columns of a table with type, nullable, default, and primary-key membership.",
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
        const result = await pool.query<ColumnRow>(
          `SELECT c.column_name,
                  c.data_type,
                  c.is_nullable,
                  c.column_default,
                  c.character_maximum_length,
                  c.numeric_precision,
                  c.numeric_scale,
                  EXISTS (
                    SELECT 1
                    FROM information_schema.table_constraints tc
                    JOIN information_schema.key_column_usage kcu
                      ON tc.constraint_name = kcu.constraint_name
                     AND tc.table_schema = kcu.table_schema
                    WHERE tc.constraint_type = 'PRIMARY KEY'
                      AND tc.table_schema = c.table_schema
                      AND tc.table_name = c.table_name
                      AND kcu.column_name = c.column_name
                  ) AS is_primary_key
           FROM information_schema.columns c
           WHERE c.table_schema = $1 AND c.table_name = $2
           ORDER BY c.ordinal_position`,
          [qualified.schema, qualified.table],
        );

        if (result.rows.length === 0) {
          return {
            content: `Table '${qualified.schema}.${qualified.table}' has no columns or does not exist.`,
            is_error: true,
          };
        }

        const header = `${qualified.schema}.${qualified.table} — ${result.rows.length} column${
          result.rows.length === 1 ? "" : "s"
        }:`;
        const lines = result.rows.map((r) => {
          const pk = r.is_primary_key ? " PRIMARY KEY" : "";
          const nullable = r.is_nullable === "NO" ? " NOT NULL" : "";
          const def = r.column_default ? ` DEFAULT ${r.column_default}` : "";
          return `${r.column_name} ${fullType(r)}${nullable}${def}${pk}`;
        });
        return { content: `${header}\n\n${lines.join("\n")}` };
      } catch (error) {
        return {
          content: postgresErrorMessage(error, `table ${input.table}`),
          is_error: true,
        };
      }
    },
  };
}
