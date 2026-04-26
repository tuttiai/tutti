import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { PostgresClient } from "../client.js";
import { guardClient } from "../utils/guard.js";
import { postgresErrorMessage } from "../utils/format.js";

const parameters = z.object({
  include_system: z
    .boolean()
    .default(false)
    .describe("Include pg_catalog, information_schema, and pg_toast"),
});

interface SchemaRow {
  schema_name: string;
  schema_owner: string;
}

export function createListSchemasTool(
  client: PostgresClient,
): Tool<z.infer<typeof parameters>> {
  return {
    name: "list_schemas",
    description: "List schemas in the connected database with their owner.",
    parameters,
    execute: async (input) => {
      const blocked = guardClient(client);
      if (blocked) return blocked;
      if (client.kind !== "ready") return { content: "unreachable", is_error: true };

      try {
        const pool = await client.wrapper.getPool();
        const sql = input.include_system
          ? `SELECT schema_name, schema_owner
             FROM information_schema.schemata
             ORDER BY schema_name`
          : `SELECT schema_name, schema_owner
             FROM information_schema.schemata
             WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
               AND schema_name NOT LIKE 'pg_temp_%'
               AND schema_name NOT LIKE 'pg_toast_temp_%'
             ORDER BY schema_name`;
        const result = await pool.query<SchemaRow>(sql);
        if (result.rows.length === 0) {
          return { content: "No schemas found." };
        }
        const lines = result.rows.map(
          (r) => `${r.schema_name} (owner: ${r.schema_owner})`,
        );
        const header = `${result.rows.length} schema${result.rows.length === 1 ? "" : "s"}:`;
        return { content: `${header}\n\n${lines.join("\n")}` };
      } catch (error) {
        return {
          content: postgresErrorMessage(error, "list_schemas"),
          is_error: true,
        };
      }
    },
  };
}
