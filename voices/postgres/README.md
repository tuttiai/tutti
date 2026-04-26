# @tuttiai/postgres

PostgreSQL voice for [Tutti](https://tutti-ai.com) — gives agents read access to a Postgres database, with a separate destructive `execute` tool for writes.

The default `query` tool runs every statement inside `BEGIN READ ONLY` so Postgres itself rejects writes with SQLSTATE `25006`, even if the connecting role has write privileges. The `execute` tool is the only writable surface and is marked `destructive: true`, so HITL-enabled runtimes gate it behind human approval before anything mutates state.

## Install

```bash
tutti-ai add postgres
# or
npm install @tuttiai/postgres
```

## Configuration

```
DATABASE_URL=postgres://user:pass@host:5432/dbname
```

`POSTGRES_URL` is also recognised. You can pass `{ connection_string }` directly to the constructor instead.

For an extra layer of defence beyond the read-only transaction wrapper, create a dedicated read-only role:

```sql
CREATE ROLE agent_reader LOGIN PASSWORD 'strong-password';
GRANT CONNECT ON DATABASE myapp TO agent_reader;
GRANT USAGE ON SCHEMA public TO agent_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO agent_reader;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO agent_reader;
```

Even if an agent finds a way to bypass the voice, the role itself cannot write.

## Tools

| Tool | Destructive | Description |
|---|---|---|
| `query` | no | Run SELECT/CTE/explain SQL inside `BEGIN READ ONLY`. Returns rows as a fixed-width table; truncated at `max_rows` (default 100, max 1000). |
| `execute` | yes | Run INSERT/UPDATE/DELETE/DDL. Returns the affected row count. Gated behind HITL when destructive-aware. |
| `list_schemas` | no | List schemas with owner. Skips system schemas by default. |
| `list_tables` | no | List tables (and views) in a schema with approximate row counts from `pg_class.reltuples`. |
| `describe_table` | no | Show columns with type, nullable, default, and primary-key membership. |
| `list_indexes` | no | List indexes on a table with the full `CREATE INDEX` definitions. |
| `explain` | no | Run `EXPLAIN` (or `EXPLAIN ANALYZE`) inside a read-only transaction. |
| `get_database_info` | no | Server version, current database, user, on-disk size, schema/table counts. |

## Constructor options

| Option | Default | Notes |
|---|---|---|
| `connection_string` | env | Overrides `DATABASE_URL` / `POSTGRES_URL`. |
| `statement_timeout_ms` | `30_000` | Server-side per-statement timeout. SQLSTATE `57014` is mapped to a clear error when exceeded. |
| `max_connections` | `5` | Pool size. Most managed Postgres providers cap connections aggressively — keep this low. |

## Example score

```ts
import { defineScore, AnthropicProvider } from "@tuttiai/core";
import { PostgresVoice } from "@tuttiai/postgres";

export default defineScore({
  provider: new AnthropicProvider(),
  agents: {
    analyst: {
      name: "analyst",
      model: "claude-sonnet-4-6",
      system_prompt:
        "You are a data analyst. The user will ask questions about the connected database. Use list_tables and describe_table before writing queries. Always parameterise values with $1, $2, ...",
      voices: [new PostgresVoice()],
    },
  },
});
```

Run it:

```bash
tutti-ai run analyst "How many orders did we have last week broken down by status?"
```

With a HITL-enabled runtime, any `execute` call pauses for human approval before execution.

## Notes & gotchas

- **Bind parameters** — always use `$1, $2, ...` placeholders. The `query` and `execute` tools take a `params` array; never string-concatenate user-supplied values.
- **Read-only enforcement is server-side** — we wrap every `query` in `BEGIN READ ONLY ... ROLLBACK` so Postgres rejects writes with SQLSTATE `25006`. This works even against superuser roles. The wrapper does **not** parse SQL.
- **Result truncation** — query results are capped at `max_rows` (default 100, max 1000) and the formatted text is capped at 8 KB. Use `LIMIT` in your SQL for predictability.
- **Identifiers can't be parameters** — `list_tables` / `describe_table` accept `schema.table` strings, but those segments are passed as bind values to information_schema, never interpolated. If you need to query identifiers that need quoting, write the SQL inline via `query`.
- **Statement timeout is per-statement, not per-tool-call** — a tool call that opens a transaction and runs multiple statements gets the timeout per statement.

## Lifecycle

The pg Pool is created lazily on the first tool call. Call `voice.teardown()` (or `TuttiRuntime.teardown()`) on shutdown to release connections cleanly.

## Links

- [Tutti](https://tutti-ai.com)
- [Voice source](https://github.com/tuttiai/tutti/tree/main/voices/postgres)
- [pg (node-postgres)](https://node-postgres.com/)
- [Postgres SQLSTATE codes](https://www.postgresql.org/docs/current/errcodes-appendix.html)

## License

Apache 2.0
