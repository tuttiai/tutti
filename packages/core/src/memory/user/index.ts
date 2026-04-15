import type { AgentUserMemoryConfig } from "@tuttiai/types";

import { SecretsManager } from "../../secrets.js";
import { MemoryUserMemoryStore } from "./memory-store.js";
import { PostgresUserMemoryStore } from "./postgres-store.js";
import type { UserMemoryStore } from "./types.js";

export type {
  AgentUserMemoryConfig,
  AgentRunOptions,
  StoreOptions,
  UserMemory,
  UserMemoryImportance,
  UserMemorySource,
  UserMemoryStore,
} from "./types.js";

export {
  DEFAULT_MAX_MEMORIES_PER_USER,
  MemoryUserMemoryStore,
  type MemoryUserMemoryStoreOptions,
} from "./memory-store.js";

export {
  PostgresUserMemoryStore,
  type PostgresUserMemoryStoreOptions,
} from "./postgres-store.js";

/**
 * Construct a {@link UserMemoryStore} from an {@link AgentUserMemoryConfig}.
 *
 * - `"memory"` → {@link MemoryUserMemoryStore} (ephemeral, dev-only).
 * - `"postgres"` → {@link PostgresUserMemoryStore}; reads the connection
 *   string from `TUTTI_PG_URL`. Throws if the env var is not set.
 *
 * @throws {Error} When `config.store` is unrecognised or the Postgres
 *   connection string is missing.
 */
export function createUserMemoryStore(
  config: AgentUserMemoryConfig,
): UserMemoryStore {
  const cap =
    config.max_memories_per_user !== undefined
      ? { max_memories_per_user: config.max_memories_per_user }
      : {};

  if (config.store === "memory") {
    return new MemoryUserMemoryStore(cap);
  }
  if (config.store === "postgres") {
    const url = SecretsManager.optional("TUTTI_PG_URL");
    if (!url) {
      throw new Error(
        "PostgresUserMemoryStore requires TUTTI_PG_URL.\n" +
          "Set it in your environment, or use { store: 'memory' } for dev.",
      );
    }
    return new PostgresUserMemoryStore({
      connection_string: url,
      ...cap,
    });
  }
  throw new Error(
    "createUserMemoryStore: unsupported store '" +
      String((config as { store: unknown }).store) +
      "'. Supported: 'memory', 'postgres'.",
  );
}
