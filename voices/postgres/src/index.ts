import type { Permission, Tool, Voice } from "@tuttiai/types";
import {
  createPostgresClient,
  type PostgresClient,
  type PostgresClientOptions,
} from "./client.js";
import { createQueryTool } from "./tools/query.js";
import { createExecuteTool } from "./tools/execute.js";
import { createListSchemasTool } from "./tools/list-schemas.js";
import { createListTablesTool } from "./tools/list-tables.js";
import { createDescribeTableTool } from "./tools/describe-table.js";
import { createListIndexesTool } from "./tools/list-indexes.js";
import { createExplainTool } from "./tools/explain.js";
import { createGetDatabaseInfoTool } from "./tools/get-database-info.js";

/** Options for {@link PostgresVoice}. */
export type PostgresVoiceOptions = PostgresClientOptions;

/**
 * Gives agents the ability to query and inspect a PostgreSQL database.
 * Read-only by default — the `query` and `explain` tools both run inside
 * `BEGIN READ ONLY` so Postgres itself rejects writes with SQLSTATE 25006
 * even if the connecting role has write privileges. The destructive
 * `execute` tool is the only writable surface and is marked
 * `destructive: true`, so HITL-enabled runtimes gate it behind human
 * approval automatically.
 *
 * The pg Pool is created lazily on the first tool call and kept warm for
 * the lifetime of the voice. Call {@link teardown} on shutdown to release
 * connections cleanly.
 */
export class PostgresVoice implements Voice {
  name = "postgres";
  description =
    "Query and inspect a PostgreSQL database (read-only by default; writes via the destructive 'execute' tool)";
  required_permissions: Permission[] = ["network"];
  tools: Tool[];

  private readonly client: PostgresClient;

  constructor(options: PostgresVoiceOptions = {}) {
    this.client = createPostgresClient(options);
    this.tools = [
      createQueryTool(this.client),
      createExecuteTool(this.client),
      createListSchemasTool(this.client),
      createListTablesTool(this.client),
      createDescribeTableTool(this.client),
      createListIndexesTool(this.client),
      createExplainTool(this.client),
      createGetDatabaseInfoTool(this.client),
    ];
  }

  async teardown(): Promise<void> {
    if (this.client.kind === "ready") {
      await this.client.wrapper.destroy();
    }
  }
}

export { createPostgresClient, PostgresClientWrapper } from "./client.js";
export type {
  PostgresClient,
  PostgresClientOptions,
  PostgresClientLike,
  PostgresPoolLike,
  PoolFactory,
} from "./client.js";
