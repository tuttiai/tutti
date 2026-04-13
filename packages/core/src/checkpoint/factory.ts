import type { AgentDurableConfig } from "@tuttiai/types";
import { SecretsManager } from "../secrets.js";
import { MemoryCheckpointStore } from "./memory.js";
import { PostgresCheckpointStore } from "./postgres.js";
import { RedisCheckpointStore, DEFAULT_CHECKPOINT_TTL_SECONDS } from "./redis.js";
import type { CheckpointStore } from "./store.js";

/**
 * Build a {@link CheckpointStore} from a durable-checkpoint configuration.
 *
 * - `"memory"` → {@link MemoryCheckpointStore} (test-only).
 * - `"redis"`  → {@link RedisCheckpointStore}; connection string pulled
 *   from `TUTTI_REDIS_URL` via {@link SecretsManager.optional}.
 * - `"postgres"` → {@link PostgresCheckpointStore}; connection string
 *   pulled from `TUTTI_PG_URL`.
 *
 * @throws When Redis or Postgres is requested but the corresponding env
 *         var is unset.
 */
export function createCheckpointStore(
  config: AgentDurableConfig,
): CheckpointStore {
  const ttl_seconds = config.ttl ?? DEFAULT_CHECKPOINT_TTL_SECONDS;

  switch (config.store) {
    case "memory":
      return new MemoryCheckpointStore();

    case "redis": {
      const url = SecretsManager.optional("TUTTI_REDIS_URL");
      if (!url) {
        throw new Error(
          "createCheckpointStore: TUTTI_REDIS_URL is required for store: 'redis'",
        );
      }
      return new RedisCheckpointStore({ url, ttl_seconds });
    }

    case "postgres": {
      const connection_string = SecretsManager.optional("TUTTI_PG_URL");
      if (!connection_string) {
        throw new Error(
          "createCheckpointStore: TUTTI_PG_URL is required for store: 'postgres'",
        );
      }
      return new PostgresCheckpointStore({ connection_string, ttl_seconds });
    }

    default: {
      // Runtime guard for values smuggled in via `as unknown`.
      const unknownStore = (config as { store: string }).store;
      throw new Error(
        "createCheckpointStore: unknown store '" + unknownStore + "'",
      );
    }
  }
}
