import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ToolContext } from "@tuttiai/types";
import { PostgresVoice } from "../src/index.js";
import type {
  PostgresClient,
  PostgresClientLike,
  PostgresPoolLike,
} from "../src/client.js";
import { PostgresClientWrapper } from "../src/client.js";
import { createQueryTool } from "../src/tools/query.js";
import { createExecuteTool } from "../src/tools/execute.js";
import { createListSchemasTool } from "../src/tools/list-schemas.js";
import { createListTablesTool } from "../src/tools/list-tables.js";
import { createDescribeTableTool } from "../src/tools/describe-table.js";
import { createListIndexesTool } from "../src/tools/list-indexes.js";
import { createExplainTool } from "../src/tools/explain.js";
import { createGetDatabaseInfoTool } from "../src/tools/get-database-info.js";
import {
  formatCell,
  formatNumber,
  formatTable,
  postgresErrorMessage,
  truncate,
} from "../src/utils/format.js";
import {
  assertIdentifier,
  quoteIdent,
  quoteQualified,
} from "../src/utils/identifiers.js";

const ctx: ToolContext = { session_id: "test", agent_name: "test" };

// ---------------------------------------------------------------------------
// Mock-factory helpers
// ---------------------------------------------------------------------------

interface MockClient extends PostgresClientLike {
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
}

function makeMockClient(): MockClient {
  return {
    query: vi.fn(async () => ({ rows: [], rowCount: 0, command: "SELECT", fields: [] })),
    release: vi.fn(),
  };
}

interface MockPool extends PostgresPoolLike {
  connect: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
}

function makeMockPool(client?: MockClient): MockPool {
  const c = client ?? makeMockClient();
  return {
    connect: vi.fn(async () => c),
    query: vi.fn(async () => ({ rows: [], rowCount: 0, command: "SELECT", fields: [] })),
    end: vi.fn(async () => undefined),
  };
}

function readyClient(pool: MockPool): { client: PostgresClient; pool: MockPool } {
  const wrapper = new PostgresClientWrapper(
    { connectionString: "postgres://x" },
    () => pool,
  );
  return {
    client: { kind: "ready", wrapper, statement_timeout_ms: 30_000 },
    pool,
  };
}

let env: { client: PostgresClient; pool: MockPool; conn: MockClient };

beforeEach(() => {
  const conn = makeMockClient();
  const pool = makeMockPool(conn);
  const r = readyClient(pool);
  env = { ...r, conn };
});

/** Build a pg-shaped DatabaseError with a SQLSTATE. */
function pgErr(code: string, message = `error ${code}`, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), { code, ...extra });
}

// ---------------------------------------------------------------------------
// PostgresVoice
// ---------------------------------------------------------------------------

describe("PostgresVoice", () => {
  it("exposes 8 tools and required_permissions=['network']", () => {
    const voice = new PostgresVoice({
      connection_string: "postgres://x",
      poolFactory: () => makeMockPool(),
    });
    expect(voice.name).toBe("postgres");
    expect(voice.required_permissions).toEqual(["network"]);
    expect(voice.tools).toHaveLength(8);
    const names = voice.tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "describe_table",
        "execute",
        "explain",
        "get_database_info",
        "list_indexes",
        "list_schemas",
        "list_tables",
        "query",
      ].sort(),
    );
  });

  it("marks only 'execute' as destructive", () => {
    const voice = new PostgresVoice({
      connection_string: "postgres://x",
      poolFactory: () => makeMockPool(),
    });
    const destructive = voice.tools
      .filter((t) => t.destructive === true)
      .map((t) => t.name);
    expect(destructive).toEqual(["execute"]);
  });

  it("teardown() ends the pool when initialised", async () => {
    const pool = makeMockPool();
    const voice = new PostgresVoice({
      connection_string: "postgres://x",
      poolFactory: () => pool,
    });
    // Trigger lazy init.
    const exec = voice.tools.find((t) => t.name === "execute");
    expect(exec).toBeDefined();
    pool.query.mockResolvedValue({ rows: [], rowCount: 0, command: "INSERT" });
    await exec!.execute(exec!.parameters.parse({ sql: "INSERT INTO t VALUES (1)" }), ctx);
    await voice.teardown();
    expect(pool.end).toHaveBeenCalledTimes(1);
  });

  it("teardown() is a no-op when never used", async () => {
    const pool = makeMockPool();
    const voice = new PostgresVoice({
      connection_string: "postgres://x",
      poolFactory: () => pool,
    });
    await voice.teardown();
    expect(pool.end).not.toHaveBeenCalled();
  });

  it("teardown() is a no-op when no connection_string", async () => {
    const voice = new PostgresVoice({});
    await expect(voice.teardown()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Client wrapper
// ---------------------------------------------------------------------------

describe("PostgresClientWrapper", () => {
  it("does not call the factory until getPool() is awaited", async () => {
    const factory = vi.fn(() => makeMockPool());
    const wrapper = new PostgresClientWrapper({ connectionString: "x" }, factory);
    expect(factory).not.toHaveBeenCalled();
    await wrapper.getPool();
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("reuses the same pool across concurrent getPool() calls", async () => {
    const pool = makeMockPool();
    const wrapper = new PostgresClientWrapper(
      { connectionString: "x" },
      () => pool,
    );
    const [a, b] = await Promise.all([wrapper.getPool(), wrapper.getPool()]);
    expect(a).toBe(b);
  });

  it("retries init after a previous factory throw", async () => {
    let call = 0;
    const factory = vi.fn(() => {
      call += 1;
      if (call === 1) throw new Error("bad init");
      return makeMockPool();
    });
    const wrapper = new PostgresClientWrapper({ connectionString: "x" }, factory);
    await expect(wrapper.getPool()).rejects.toThrow("bad init");
    await expect(wrapper.getPool()).resolves.toBeDefined();
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("destroy() ends the pool and clears it", async () => {
    const pool = makeMockPool();
    const wrapper = new PostgresClientWrapper({ connectionString: "x" }, () => pool);
    await wrapper.getPool();
    await wrapper.destroy();
    expect(pool.end).toHaveBeenCalledTimes(1);
    // A second getPool() rebuilds.
    const pool2 = makeMockPool();
    const factory = vi.fn(() => pool2);
    const wrapper2 = new PostgresClientWrapper({ connectionString: "x" }, factory);
    await wrapper2.getPool();
    await wrapper2.destroy();
    await wrapper2.getPool();
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("destroy() before getPool() is a no-op", async () => {
    const pool = makeMockPool();
    const wrapper = new PostgresClientWrapper({ connectionString: "x" }, () => pool);
    await wrapper.destroy();
    expect(pool.end).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Auth gating
// ---------------------------------------------------------------------------

describe("auth gating", () => {
  it("query returns is_error when no connection string", async () => {
    const missing: PostgresClient = { kind: "missing", message: "Postgres not configured." };
    const tool = createQueryTool(missing);
    const result = await tool.execute(tool.parameters.parse({ sql: "SELECT 1" }), ctx);
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("not configured");
  });

  it("execute returns is_error when no connection string", async () => {
    const missing: PostgresClient = { kind: "missing", message: "Postgres not configured." };
    const tool = createExecuteTool(missing);
    const result = await tool.execute(
      tool.parameters.parse({ sql: "DELETE FROM t" }),
      ctx,
    );
    expect(result.is_error).toBe(true);
  });

  it("get_database_info returns is_error when no connection string", async () => {
    const missing: PostgresClient = { kind: "missing", message: "Postgres not configured." };
    const tool = createGetDatabaseInfoTool(missing);
    const result = await tool.execute(tool.parameters.parse({}), ctx);
    expect(result.is_error).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// query
// ---------------------------------------------------------------------------

describe("query", () => {
  it("wraps the SQL in BEGIN READ ONLY ... ROLLBACK and formats rows", async () => {
    env.conn.query.mockImplementation(async (text: string) => {
      if (text === "BEGIN READ ONLY" || text === "ROLLBACK") {
        return { rows: [], rowCount: 0, command: "BEGIN", fields: [] };
      }
      return {
        rows: [{ id: 1, name: "alice" }, { id: 2, name: "bob" }],
        rowCount: 2,
        command: "SELECT",
        fields: [{ name: "id" }, { name: "name" }],
      };
    });

    const tool = createQueryTool(env.client);
    const result = await tool.execute(
      tool.parameters.parse({ sql: "SELECT id, name FROM users", params: [] }),
      ctx,
    );
    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain("2 rows");
    expect(result.content).toContain("id");
    expect(result.content).toContain("name");
    expect(result.content).toContain("alice");
    expect(result.content).toContain("bob");

    const calls = env.conn.query.mock.calls.map((c) => c[0]);
    expect(calls[0]).toBe("BEGIN READ ONLY");
    expect(calls[1]).toBe("SELECT id, name FROM users");
    expect(calls[2]).toBe("ROLLBACK");
    expect(env.conn.release).toHaveBeenCalledTimes(1);
  });

  it("forwards params to pg.query", async () => {
    env.conn.query.mockImplementation(async (text: string, values?: unknown[]) => {
      if (text.startsWith("SELECT")) {
        expect(values).toEqual([42, "x"]);
      }
      return { rows: [], rowCount: 0, command: "SELECT", fields: [] };
    });
    const tool = createQueryTool(env.client);
    await tool.execute(
      tool.parameters.parse({
        sql: "SELECT * FROM t WHERE a=$1 AND b=$2",
        params: [42, "x"],
      }),
      ctx,
    );
  });

  it("truncates rows beyond max_rows", async () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({ id: i }));
    env.conn.query.mockImplementation(async (text: string) => {
      if (text === "BEGIN READ ONLY" || text === "ROLLBACK") {
        return { rows: [], rowCount: 0, command: "BEGIN", fields: [] };
      }
      return { rows, rowCount: 50, command: "SELECT", fields: [{ name: "id" }] };
    });
    const tool = createQueryTool(env.client);
    const result = await tool.execute(
      tool.parameters.parse({ sql: "SELECT * FROM t", max_rows: 10 }),
      ctx,
    );
    expect(result.content).toContain("10 rows (truncated from 50)");
  });

  it("rejects writes via SQLSTATE 25006 with helpful message", async () => {
    env.conn.query.mockImplementation(async (text: string) => {
      if (text === "BEGIN READ ONLY" || text === "ROLLBACK") {
        return { rows: [], rowCount: 0, command: "BEGIN", fields: [] };
      }
      throw pgErr("25006", "cannot execute INSERT in a read-only transaction");
    });
    const tool = createQueryTool(env.client);
    const result = await tool.execute(
      tool.parameters.parse({ sql: "INSERT INTO t VALUES (1)" }),
      ctx,
    );
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("[25006]");
    expect(result.content).toContain("read-only transaction");
    expect(result.content).toContain("'execute' tool");
    // Connection still released even after failure.
    expect(env.conn.release).toHaveBeenCalledTimes(1);
  });

  it("releases the connection even when ROLLBACK itself fails after a query error", async () => {
    let rollbackCalls = 0;
    env.conn.query.mockImplementation(async (text: string) => {
      if (text === "BEGIN READ ONLY") {
        return { rows: [], rowCount: 0, command: "BEGIN", fields: [] };
      }
      if (text === "ROLLBACK") {
        rollbackCalls += 1;
        throw new Error("rollback failed");
      }
      throw pgErr("42P01", "relation does not exist");
    });
    const tool = createQueryTool(env.client);
    const result = await tool.execute(
      tool.parameters.parse({ sql: "SELECT * FROM nope" }),
      ctx,
    );
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("[42P01]");
    expect(rollbackCalls).toBe(1);
    expect(env.conn.release).toHaveBeenCalledTimes(1);
  });

  it("returns is_error when getPool itself fails", async () => {
    const wrapper = new PostgresClientWrapper({ connectionString: "x" }, () => {
      throw new Error("connection refused");
    });
    const client: PostgresClient = {
      kind: "ready",
      wrapper,
      statement_timeout_ms: 30_000,
    };
    const tool = createQueryTool(client);
    const result = await tool.execute(
      tool.parameters.parse({ sql: "SELECT 1" }),
      ctx,
    );
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("connection refused");
  });

  it("emits a useful header when there are zero result rows", async () => {
    env.conn.query.mockImplementation(async (text: string) => {
      if (text === "BEGIN READ ONLY" || text === "ROLLBACK") {
        return { rows: [], rowCount: 0, command: "BEGIN", fields: [] };
      }
      return {
        rows: [],
        rowCount: 0,
        command: "SELECT",
        fields: [{ name: "id" }],
      };
    });
    const tool = createQueryTool(env.client);
    const result = await tool.execute(
      tool.parameters.parse({ sql: "SELECT id FROM t WHERE FALSE" }),
      ctx,
    );
    expect(result.content).toContain("0 rows");
    expect(result.content).toContain("(no rows)");
  });
});

// ---------------------------------------------------------------------------
// execute
// ---------------------------------------------------------------------------

describe("execute", () => {
  it("runs the SQL and reports rowCount + command", async () => {
    env.pool.query.mockResolvedValue({
      rows: [],
      rowCount: 3,
      command: "DELETE",
    });
    const tool = createExecuteTool(env.client);
    const result = await tool.execute(
      tool.parameters.parse({ sql: "DELETE FROM t WHERE x=$1", params: [1] }),
      ctx,
    );
    expect(result.is_error).toBeUndefined();
    expect(result.content).toBe("DELETE — 3 rows affected");
    expect(env.pool.query).toHaveBeenCalledWith(
      "DELETE FROM t WHERE x=$1",
      [1],
    );
  });

  it("singularises 'row affected' for rowCount=1", async () => {
    env.pool.query.mockResolvedValue({ rows: [], rowCount: 1, command: "INSERT" });
    const tool = createExecuteTool(env.client);
    const result = await tool.execute(
      tool.parameters.parse({ sql: "INSERT INTO t VALUES (1)" }),
      ctx,
    );
    expect(result.content).toBe("INSERT — 1 row affected");
  });

  it("returns is_error on pg failure with SQLSTATE", async () => {
    env.pool.query.mockRejectedValue(pgErr("23505", "duplicate key", { detail: "Key (id)=(1) already exists." }));
    const tool = createExecuteTool(env.client);
    const result = await tool.execute(
      tool.parameters.parse({ sql: "INSERT INTO t VALUES (1)" }),
      ctx,
    );
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("[23505]");
    expect(result.content).toContain("Unique constraint");
    expect(result.content).toContain("Key (id)=(1)");
  });
});

// ---------------------------------------------------------------------------
// list_schemas
// ---------------------------------------------------------------------------

describe("list_schemas", () => {
  it("excludes system schemas by default", async () => {
    env.pool.query.mockImplementation(async (text: string) => {
      expect(text).toContain("NOT IN ('pg_catalog'");
      return {
        rows: [{ schema_name: "public", schema_owner: "postgres" }],
        rowCount: 1,
        command: "SELECT",
      };
    });
    const tool = createListSchemasTool(env.client);
    const result = await tool.execute(tool.parameters.parse({}), ctx);
    expect(result.content).toContain("1 schema");
    expect(result.content).toContain("public (owner: postgres)");
  });

  it("includes system schemas when requested", async () => {
    env.pool.query.mockImplementation(async (text: string) => {
      expect(text).not.toContain("NOT IN");
      return {
        rows: [
          { schema_name: "public", schema_owner: "postgres" },
          { schema_name: "pg_catalog", schema_owner: "postgres" },
        ],
        rowCount: 2,
        command: "SELECT",
      };
    });
    const tool = createListSchemasTool(env.client);
    const result = await tool.execute(
      tool.parameters.parse({ include_system: true }),
      ctx,
    );
    expect(result.content).toContain("2 schemas");
    expect(result.content).toContain("pg_catalog");
  });

  it("reports an empty result", async () => {
    env.pool.query.mockResolvedValue({ rows: [], rowCount: 0, command: "SELECT" });
    const tool = createListSchemasTool(env.client);
    const result = await tool.execute(tool.parameters.parse({}), ctx);
    expect(result.content).toContain("No schemas");
  });

  it("returns is_error on pg failure", async () => {
    env.pool.query.mockRejectedValue(pgErr("28P01"));
    const tool = createListSchemasTool(env.client);
    const result = await tool.execute(tool.parameters.parse({}), ctx);
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("authentication failed");
  });
});

// ---------------------------------------------------------------------------
// list_tables
// ---------------------------------------------------------------------------

describe("list_tables", () => {
  it("lists tables and views in a schema with row counts", async () => {
    env.pool.query.mockImplementation(async (_text: string, values?: unknown[]) => {
      expect(values).toEqual(["public", ["BASE TABLE", "VIEW"]]);
      return {
        rows: [
          {
            table_schema: "public",
            table_name: "users",
            table_type: "BASE TABLE",
            approximate_row_count: "1234",
          },
          {
            table_schema: "public",
            table_name: "active_users",
            table_type: "VIEW",
            approximate_row_count: "0",
          },
        ],
        rowCount: 2,
        command: "SELECT",
      };
    });
    const tool = createListTablesTool(env.client);
    const result = await tool.execute(tool.parameters.parse({}), ctx);
    expect(result.content).toContain("2 tables in 'public'");
    expect(result.content).toContain("users (table) ~1,234 rows");
    expect(result.content).toContain("active_users (view)");
  });

  it("excludes views when include_views=false", async () => {
    env.pool.query.mockImplementation(async (_text: string, values?: unknown[]) => {
      expect(values).toEqual(["public", ["BASE TABLE"]]);
      return { rows: [], rowCount: 0, command: "SELECT" };
    });
    const tool = createListTablesTool(env.client);
    await tool.execute(
      tool.parameters.parse({ include_views: false }),
      ctx,
    );
  });

  it("reports empty schema", async () => {
    env.pool.query.mockResolvedValue({ rows: [], rowCount: 0, command: "SELECT" });
    const tool = createListTablesTool(env.client);
    const result = await tool.execute(
      tool.parameters.parse({ schema: "empty" }),
      ctx,
    );
    expect(result.content).toContain("No tables in schema 'empty'");
  });
});

// ---------------------------------------------------------------------------
// describe_table
// ---------------------------------------------------------------------------

describe("describe_table", () => {
  it("formats columns with type, NOT NULL, default, and PRIMARY KEY", async () => {
    env.pool.query.mockImplementation(async (_text: string, values?: unknown[]) => {
      expect(values).toEqual(["public", "users"]);
      return {
        rows: [
          {
            column_name: "id",
            data_type: "integer",
            is_nullable: "NO",
            column_default: "nextval('users_id_seq'::regclass)",
            character_maximum_length: null,
            numeric_precision: 32,
            numeric_scale: 0,
            is_primary_key: true,
          },
          {
            column_name: "email",
            data_type: "character varying",
            is_nullable: "NO",
            column_default: null,
            character_maximum_length: 255,
            numeric_precision: null,
            numeric_scale: null,
            is_primary_key: false,
          },
          {
            column_name: "bio",
            data_type: "text",
            is_nullable: "YES",
            column_default: null,
            character_maximum_length: null,
            numeric_precision: null,
            numeric_scale: null,
            is_primary_key: false,
          },
        ],
        rowCount: 3,
        command: "SELECT",
      };
    });
    const tool = createDescribeTableTool(env.client);
    const result = await tool.execute(
      tool.parameters.parse({ table: "users" }),
      ctx,
    );
    expect(result.content).toContain("public.users");
    expect(result.content).toContain("3 columns");
    expect(result.content).toContain("id integer(32,0) NOT NULL DEFAULT nextval");
    expect(result.content).toContain("PRIMARY KEY");
    expect(result.content).toContain("email character varying(255) NOT NULL");
    expect(result.content).toContain("bio text");
    expect(result.content).not.toMatch(/bio text NOT NULL/);
  });

  it("accepts schema-qualified names", async () => {
    env.pool.query.mockImplementation(async (_text: string, values?: unknown[]) => {
      expect(values).toEqual(["analytics", "events"]);
      return { rows: [], rowCount: 0, command: "SELECT" };
    });
    const tool = createDescribeTableTool(env.client);
    const result = await tool.execute(
      tool.parameters.parse({ table: "analytics.events" }),
      ctx,
    );
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("analytics.events");
  });

  it("rejects three-part names", async () => {
    const tool = createDescribeTableTool(env.client);
    const result = await tool.execute(
      tool.parameters.parse({ table: "a.b.c" }),
      ctx,
    );
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("Use 'table' or 'schema.table'");
  });
});

// ---------------------------------------------------------------------------
// list_indexes
// ---------------------------------------------------------------------------

describe("list_indexes", () => {
  it("lists indexes with full DDL", async () => {
    env.pool.query.mockImplementation(async (_text: string, values?: unknown[]) => {
      expect(values).toEqual(["public", "users"]);
      return {
        rows: [
          {
            indexname: "users_pkey",
            indexdef: "CREATE UNIQUE INDEX users_pkey ON public.users USING btree (id)",
          },
          {
            indexname: "users_email_idx",
            indexdef: "CREATE UNIQUE INDEX users_email_idx ON public.users USING btree (email)",
          },
        ],
        rowCount: 2,
        command: "SELECT",
      };
    });
    const tool = createListIndexesTool(env.client);
    const result = await tool.execute(
      tool.parameters.parse({ table: "users" }),
      ctx,
    );
    expect(result.content).toContain("2 indexes on public.users");
    expect(result.content).toContain("users_pkey");
    expect(result.content).toContain("USING btree (email)");
  });

  it("reports tables with no indexes", async () => {
    env.pool.query.mockResolvedValue({ rows: [], rowCount: 0, command: "SELECT" });
    const tool = createListIndexesTool(env.client);
    const result = await tool.execute(
      tool.parameters.parse({ table: "logs" }),
      ctx,
    );
    expect(result.content).toContain("No indexes on 'public.logs'");
  });

  it("rejects invalid qualified names", async () => {
    const tool = createListIndexesTool(env.client);
    const result = await tool.execute(
      tool.parameters.parse({ table: "a.b.c" }),
      ctx,
    );
    expect(result.is_error).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// explain
// ---------------------------------------------------------------------------

describe("explain", () => {
  it("runs EXPLAIN VERBOSE inside a read-only transaction", async () => {
    const calls: string[] = [];
    env.conn.query.mockImplementation(async (text: string) => {
      calls.push(text);
      if (text === "BEGIN READ ONLY" || text === "ROLLBACK") {
        return { rows: [], rowCount: 0, command: "BEGIN", fields: [] };
      }
      return {
        rows: [
          { "QUERY PLAN": "Seq Scan on users  (cost=0.00..1.00 rows=10)" },
          { "QUERY PLAN": "  Output: id, email" },
        ],
        rowCount: 2,
        command: "EXPLAIN",
      };
    });
    const tool = createExplainTool(env.client);
    const result = await tool.execute(
      tool.parameters.parse({ sql: "SELECT * FROM users" }),
      ctx,
    );
    expect(calls[0]).toBe("BEGIN READ ONLY");
    expect(calls[1]).toBe("EXPLAIN (VERBOSE) SELECT * FROM users");
    expect(calls[2]).toBe("ROLLBACK");
    expect(result.content).toContain("Seq Scan");
    expect(result.content).toContain("Output:");
  });

  it("uses ANALYZE prefix when requested", async () => {
    const calls: string[] = [];
    env.conn.query.mockImplementation(async (text: string) => {
      calls.push(text);
      if (text === "BEGIN READ ONLY" || text === "ROLLBACK") {
        return { rows: [], rowCount: 0, command: "BEGIN", fields: [] };
      }
      return { rows: [{ "QUERY PLAN": "x" }], rowCount: 1, command: "EXPLAIN" };
    });
    const tool = createExplainTool(env.client);
    await tool.execute(
      tool.parameters.parse({ sql: "SELECT 1", analyze: true }),
      ctx,
    );
    expect(calls[1]).toBe("EXPLAIN (ANALYZE, BUFFERS, VERBOSE) SELECT 1");
  });

  it("returns is_error when the query is bad", async () => {
    env.conn.query.mockImplementation(async (text: string) => {
      if (text === "BEGIN READ ONLY" || text === "ROLLBACK") {
        return { rows: [], rowCount: 0, command: "BEGIN", fields: [] };
      }
      throw pgErr("42601", "syntax error", { position: "8" });
    });
    const tool = createExplainTool(env.client);
    const result = await tool.execute(
      tool.parameters.parse({ sql: "SELEKT" }),
      ctx,
    );
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("[42601]");
    expect(result.content).toContain("Position: 8");
  });
});

// ---------------------------------------------------------------------------
// get_database_info
// ---------------------------------------------------------------------------

describe("get_database_info", () => {
  it("formats the info row", async () => {
    env.pool.query.mockResolvedValue({
      rows: [
        {
          version: "PostgreSQL 16.1 on x86_64-pc-linux-gnu",
          current_database: "myapp",
          current_user: "agent_reader",
          server_addr: "10.0.0.1",
          server_port: 5432,
          database_size: "1234 MB",
          schema_count: "5",
          table_count: "42",
        },
      ],
      rowCount: 1,
      command: "SELECT",
    });
    const tool = createGetDatabaseInfoTool(env.client);
    const result = await tool.execute(tool.parameters.parse({}), ctx);
    expect(result.content).toContain("Database: myapp");
    expect(result.content).toContain("User: agent_reader");
    expect(result.content).toContain("Server: 10.0.0.1:5432");
    expect(result.content).toContain("Size: 1234 MB");
    expect(result.content).toContain("Schemas: 5");
    expect(result.content).toContain("Tables: 42");
    expect(result.content).toContain("PostgreSQL 16.1");
  });

  it("falls back to 'local' when server_addr is null", async () => {
    env.pool.query.mockResolvedValue({
      rows: [
        {
          version: "PostgreSQL 16.1",
          current_database: "myapp",
          current_user: "u",
          server_addr: null,
          server_port: null,
          database_size: "1 MB",
          schema_count: "1",
          table_count: "1",
        },
      ],
      rowCount: 1,
      command: "SELECT",
    });
    const tool = createGetDatabaseInfoTool(env.client);
    const result = await tool.execute(tool.parameters.parse({}), ctx);
    expect(result.content).toContain("Server: local");
  });

  it("returns is_error when no row comes back", async () => {
    env.pool.query.mockResolvedValue({ rows: [], rowCount: 0, command: "SELECT" });
    const tool = createGetDatabaseInfoTool(env.client);
    const result = await tool.execute(tool.parameters.parse({}), ctx);
    expect(result.is_error).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// format utilities
// ---------------------------------------------------------------------------

describe("format utilities", () => {
  it("postgresErrorMessage maps every documented SQLSTATE", () => {
    expect(postgresErrorMessage(pgErr("28P01"))).toContain("authentication failed");
    expect(postgresErrorMessage(pgErr("28000"))).toContain("authentication failed");
    expect(postgresErrorMessage(pgErr("3D000"))).toContain("Database does not exist");
    expect(postgresErrorMessage(pgErr("42P01", "no rel", { detail: "x" }))).toContain(
      "Relation does not exist",
    );
    expect(postgresErrorMessage(pgErr("42703"))).toContain("Column does not exist");
    expect(postgresErrorMessage(pgErr("42501"))).toContain("Permission denied");
    expect(postgresErrorMessage(pgErr("42601", "x", { position: "5" }))).toContain(
      "Position: 5",
    );
    expect(postgresErrorMessage(pgErr("23505"))).toContain("Unique constraint");
    expect(postgresErrorMessage(pgErr("23503"))).toContain("Foreign-key violation");
    expect(postgresErrorMessage(pgErr("23502"))).toContain("Not-null violation");
    expect(postgresErrorMessage(pgErr("53300"))).toContain("Too many connections");
    expect(postgresErrorMessage(pgErr("57014"))).toContain("statement_timeout");
    expect(postgresErrorMessage(pgErr("25006"))).toContain("read-only transaction");
  });

  it("postgresErrorMessage falls back for unknown SQLSTATEs", () => {
    expect(postgresErrorMessage(pgErr("XX999", "weird"))).toContain("[XX999]");
    expect(postgresErrorMessage(pgErr("XX999", "weird"))).toContain("weird");
  });

  it("postgresErrorMessage handles a generic Error without code", () => {
    expect(postgresErrorMessage(new Error("boom"))).toContain("boom");
  });

  it("postgresErrorMessage handles non-Error input", () => {
    expect(postgresErrorMessage("string err")).toBe("string err");
  });

  it("formatNumber adds commas", () => {
    expect(formatNumber(1234567)).toBe("1,234,567");
  });

  it("truncate shortens long strings", () => {
    expect(truncate("abcdefghij", 7)).toBe("abcd...");
    expect(truncate("abc", 10)).toBe("abc");
  });

  it("formatCell handles every type", () => {
    expect(formatCell(null)).toBe("NULL");
    expect(formatCell(undefined)).toBe("NULL");
    expect(formatCell(42)).toBe("42");
    expect(formatCell(true)).toBe("true");
    expect(formatCell("hello")).toBe("hello");
    expect(formatCell(new Date(0))).toBe(new Date(0).toISOString());
    expect(formatCell({ a: 1 })).toBe('{"a":1}');
    expect(formatCell(Buffer.from("abc"))).toBe("<bytea 3B>");
    expect(formatCell(BigInt(42))).toBe("42");
  });

  it("formatCell falls back to <unprintable> for unserialisable input", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(formatCell(cyclic)).toBe("<unprintable>");
  });

  it("formatTable handles the empty cases", () => {
    expect(formatTable([], [])).toBe("(no columns)");
    expect(formatTable(["id"], [])).toContain("(no rows)");
  });

  it("formatTable produces a fixed-width grid", () => {
    const out = formatTable(["id", "name"], [
      { id: 1, name: "alice" },
      { id: 22, name: "bob" },
    ]);
    expect(out).toContain("id | name");
    expect(out).toContain("1");
    expect(out).toContain("alice");
    expect(out).toContain("bob");
  });
});

// ---------------------------------------------------------------------------
// identifier helpers
// ---------------------------------------------------------------------------

describe("identifier helpers", () => {
  it("assertIdentifier accepts plain ASCII identifiers", () => {
    expect(assertIdentifier("users")).toBe("users");
    expect(assertIdentifier("_private")).toBe("_private");
    expect(assertIdentifier("Table42")).toBe("Table42");
  });

  it("assertIdentifier rejects punctuation, spaces, leading digits", () => {
    expect(() => assertIdentifier("a b")).toThrow();
    expect(() => assertIdentifier("1abc")).toThrow();
    expect(() => assertIdentifier('a";DROP')).toThrow();
    expect(() => assertIdentifier("")).toThrow();
  });

  it("quoteIdent doubles embedded quotes", () => {
    expect(quoteIdent("col")).toBe('"col"');
    expect(quoteIdent('weird"name')).toBe('"weird""name"');
  });

  it("quoteQualified handles single + double segments", () => {
    expect(quoteQualified("users")).toBe('"users"');
    expect(quoteQualified("public.users")).toBe('"public"."users"');
  });

  it("quoteQualified rejects three-part and bad segments", () => {
    expect(() => quoteQualified("a.b.c")).toThrow();
    expect(() => quoteQualified("a.1bad")).toThrow();
  });
});
