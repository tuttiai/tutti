import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createCheckpointStore,
  MemoryCheckpointStore,
  PostgresCheckpointStore,
  RedisCheckpointStore,
} from "../../src/checkpoint/index.js";

describe("createCheckpointStore", () => {
  const env = process.env as Record<string, string | undefined>;
  let savedRedis: string | undefined;
  let savedPg: string | undefined;

  beforeEach(() => {
    savedRedis = env.TUTTI_REDIS_URL;
    savedPg = env.TUTTI_PG_URL;
  });

  afterEach(() => {
    if (savedRedis === undefined) delete env.TUTTI_REDIS_URL;
    else env.TUTTI_REDIS_URL = savedRedis;
    if (savedPg === undefined) delete env.TUTTI_PG_URL;
    else env.TUTTI_PG_URL = savedPg;
  });

  it("dispatches to MemoryCheckpointStore for `memory`", () => {
    const store = createCheckpointStore({ store: "memory" });
    expect(store).toBeInstanceOf(MemoryCheckpointStore);
  });

  it("dispatches to RedisCheckpointStore when TUTTI_REDIS_URL is set", () => {
    env.TUTTI_REDIS_URL = "redis://127.0.0.1:6379/0";
    const store = createCheckpointStore({ store: "redis" });
    expect(store).toBeInstanceOf(RedisCheckpointStore);
  });

  it("dispatches to PostgresCheckpointStore when TUTTI_PG_URL is set", () => {
    env.TUTTI_PG_URL = "postgres://x:y@host/db";
    const store = createCheckpointStore({ store: "postgres" });
    expect(store).toBeInstanceOf(PostgresCheckpointStore);
  });

  it("throws when redis is requested but TUTTI_REDIS_URL is unset", () => {
    delete env.TUTTI_REDIS_URL;
    expect(() => createCheckpointStore({ store: "redis" })).toThrow(
      /TUTTI_REDIS_URL/,
    );
  });

  it("throws when postgres is requested but TUTTI_PG_URL is unset", () => {
    delete env.TUTTI_PG_URL;
    expect(() => createCheckpointStore({ store: "postgres" })).toThrow(
      /TUTTI_PG_URL/,
    );
  });

  it("rejects unknown store values at runtime", () => {
    const bad = { store: "mongo" } as unknown as { store: "memory" };
    expect(() => createCheckpointStore(bad)).toThrow(/unknown store/);
  });
});
