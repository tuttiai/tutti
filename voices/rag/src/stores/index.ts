import type { RagConfig } from "../types.js";
import { MemoryVectorStore } from "./memory.js";
import { PgVectorStore } from "./pgvector.js";
import type { VectorStore, VectorStoreConfig } from "./types.js";

export type {
  VectorStore,
  EmbeddedChunk,
  VectorStoreConfig,
  MemoryStoreConfig,
  PgVectorStoreConfig,
} from "./types.js";
export { MemoryVectorStore } from "./memory.js";
export { PgVectorStore } from "./pgvector.js";

/**
 * Construct a {@link VectorStore} from a {@link RagConfig}.
 *
 * Falls back to an in-memory store when `config.storage` is unset — useful
 * for quickstarts and tests, but explicitly *not* suitable for production.
 */
export function createVectorStore(config: RagConfig): VectorStore {
  const storage = config.storage ?? { provider: "memory" as const };
  return dispatch(storage);
}

function dispatch(config: VectorStoreConfig): VectorStore {
  switch (config.provider) {
    case "memory":
      return new MemoryVectorStore(config);
    case "pgvector":
      return new PgVectorStore(config);
    default: {
      // Runtime guard for values smuggled in via `as unknown`.
      const unknown = (config as { provider: string }).provider;
      throw new Error("createVectorStore: unknown provider '" + unknown + "'");
    }
  }
}
