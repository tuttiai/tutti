import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { PostgresClient } from "../client.js";
import { guardClient } from "../utils/guard.js";
import { formatNumber, postgresErrorMessage } from "../utils/format.js";

const parameters = z.object({
  sql: z
    .string()
    .min(1)
    .describe(
      "Write SQL to run (INSERT/UPDATE/DELETE/CREATE/ALTER/DROP/...). Use $1, $2, ... for parameters; never string-concatenate values.",
    ),
  params: z
    .array(z.unknown())
    .max(100)
    .default([])
    .describe("Bind parameters for the SQL placeholders."),
});

export function createExecuteTool(client: PostgresClient): Tool<z.infer<typeof parameters>> {
  return {
    name: "execute",
    description:
      "Run a write SQL statement (INSERT/UPDATE/DELETE/DDL). This is the destructive escape hatch from the read-only 'query' tool — HITL-enabled runtimes will gate it behind operator approval. Returns the affected row count.",
    parameters,
    destructive: true,
    execute: async (input) => {
      const blocked = guardClient(client);
      if (blocked) return blocked;
      if (client.kind !== "ready") return { content: "unreachable", is_error: true };

      try {
        const pool = await client.wrapper.getPool();
        const result = await pool.query(input.sql, input.params);
        const command = result.command ?? "OK";
        const rowCount = result.rowCount ?? 0;
        return {
          content: `${command} — ${formatNumber(rowCount)} row${rowCount === 1 ? "" : "s"} affected`,
        };
      } catch (error) {
        return { content: postgresErrorMessage(error, "execute"), is_error: true };
      }
    },
  };
}
