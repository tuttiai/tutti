import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { PostgresClient } from "../client.js";
import { guardClient } from "../utils/guard.js";
import { postgresErrorMessage } from "../utils/format.js";

const parameters = z.object({});

interface InfoRow {
  version: string;
  current_database: string;
  current_user: string;
  server_addr: string | null;
  server_port: number | null;
  database_size: string;
  schema_count: string;
  table_count: string;
}

export function createGetDatabaseInfoTool(
  client: PostgresClient,
): Tool<z.infer<typeof parameters>> {
  return {
    name: "get_database_info",
    description:
      "Fetch server version, current database/user, on-disk size, and counts of schemas + tables.",
    parameters,
    execute: async () => {
      const blocked = guardClient(client);
      if (blocked) return blocked;
      if (client.kind !== "ready") return { content: "unreachable", is_error: true };

      try {
        const pool = await client.wrapper.getPool();
        const result = await pool.query<InfoRow>(
          `SELECT
             version() AS version,
             current_database() AS current_database,
             current_user AS current_user,
             inet_server_addr()::text AS server_addr,
             inet_server_port() AS server_port,
             pg_size_pretty(pg_database_size(current_database())) AS database_size,
             (SELECT count(*)::text FROM information_schema.schemata
              WHERE schema_name NOT IN ('pg_catalog','information_schema','pg_toast')
                AND schema_name NOT LIKE 'pg_temp_%'
                AND schema_name NOT LIKE 'pg_toast_temp_%'
             ) AS schema_count,
             (SELECT count(*)::text FROM information_schema.tables
              WHERE table_schema NOT IN ('pg_catalog','information_schema','pg_toast')
                AND table_type = 'BASE TABLE'
             ) AS table_count`,
        );

        const row = result.rows[0];
        if (!row) {
          return {
            content: "Postgres returned no rows for the info query.",
            is_error: true,
          };
        }
        const lines = [
          `Database: ${row.current_database}`,
          `User: ${row.current_user}`,
          `Server: ${row.server_addr ?? "local"}${row.server_port ? `:${row.server_port}` : ""}`,
          `Size: ${row.database_size}`,
          `Schemas: ${row.schema_count}`,
          `Tables: ${row.table_count}`,
          `Version: ${row.version.split("\n")[0] ?? row.version}`,
        ];
        return { content: lines.join("\n") };
      } catch (error) {
        return {
          content: postgresErrorMessage(error, "get_database_info"),
          is_error: true,
        };
      }
    },
  };
}
