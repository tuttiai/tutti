import Redis from "ioredis";
import { logger } from "../logger.js";
import type { CheckpointStore } from "./store.js";
import type { Checkpoint } from "./types.js";

/**
 * Default TTL for durable checkpoints — 7 days in seconds. Matches
 * {@link AgentDurableConfig.ttl}'s documented default.
 */
export const DEFAULT_CHECKPOINT_TTL_SECONDS = 604_800;

const DEFAULT_PREFIX = "tutti:checkpoint";

// Session IDs must not contain characters that would break our key pattern
// or SCAN match. UUIDs and hex strings pass cleanly; anything else is rejected.
const SESSION_ID_RE = /^[A-Za-z0-9._-]+$/;

export interface RedisCheckpointStoreOptions {
  /** Redis connection URL, e.g. `redis://default:pass@host:6379/0`. */
  url: string;
  /** Key-prefix override (default `tutti:checkpoint`). */
  key_prefix?: string;
  /** Retention in seconds (default 604800 / 7 days). */
  ttl_seconds?: number;
}

/**
 * Redis-backed {@link CheckpointStore}.
 *
 * Key layout:
 * - `{prefix}:{session_id}:{turn}` — JSON-encoded {@link Checkpoint}
 * - `{prefix}:{session_id}:latest` — numeric turn pointer
 *
 * Every `save` writes both keys in a single pipeline and applies the
 * configured TTL to each. `loadLatest` does a two-hop read
 * (latest pointer → turn key). `delete` / `list` use `SCAN` so a
 * thousand-checkpoint session doesn't block the Redis event loop the way
 * `KEYS` would.
 */
export class RedisCheckpointStore implements CheckpointStore {
  private readonly client: Redis;
  private readonly prefix: string;
  private readonly ttl: number;

  constructor(options: RedisCheckpointStoreOptions) {
    this.client = new Redis(options.url, { lazyConnect: true });
    this.prefix = options.key_prefix ?? DEFAULT_PREFIX;
    this.ttl = options.ttl_seconds ?? DEFAULT_CHECKPOINT_TTL_SECONDS;

    this.client.on("error", (err: Error) => {
      logger.error(
        { error: err.message },
        "RedisCheckpointStore: client error",
      );
    });
  }

  async save(checkpoint: Checkpoint): Promise<void> {
    assertSafeSessionId(checkpoint.session_id);
    const turnKey = this.turnKey(checkpoint.session_id, checkpoint.turn);
    const latestKey = this.latestKey(checkpoint.session_id);

    // NOTE: the `latest` pointer is bumped unconditionally per the spec.
    // Out-of-order saves (turn 5 then turn 3) will leave the pointer at
    // the most recently written turn, not the numerically highest. In
    // practice checkpoints are written in order, so this is a reasonable
    // trade-off for the simpler / cheaper pipeline.
    const pipeline = this.client.pipeline();
    pipeline.set(turnKey, JSON.stringify(checkpoint), "EX", this.ttl);
    pipeline.set(latestKey, String(checkpoint.turn), "EX", this.ttl);
    const results = await pipeline.exec();

    // pipeline.exec() returns [[err, result], ...] — per-command failures
    // are NOT thrown. Without this check an OOM or auth drift on either
    // SET would leave the caller thinking the checkpoint was durable.
    if (results === null) {
      throw new Error(
        "RedisCheckpointStore: pipeline aborted before any command ran",
      );
    }
    for (const [err] of results) {
      if (err) {
        throw new Error(
          "RedisCheckpointStore: save failed — " + err.message,
        );
      }
    }
  }

  async loadLatest(session_id: string): Promise<Checkpoint | null> {
    assertSafeSessionId(session_id);
    const latest = await this.client.get(this.latestKey(session_id));
    if (latest === null) return null;
    const turn = Number(latest);
    // `isFinite` rejects NaN/Infinity (malformed pointer) while still
    // accepting any value the Checkpoint contract admits — `turn: number`
    // is not constrained to integers.
    if (!Number.isFinite(turn)) {
      logger.warn(
        { session_id, value: latest },
        "RedisCheckpointStore: malformed latest pointer, ignoring",
      );
      return null;
    }
    return this.load(session_id, turn);
  }

  async load(session_id: string, turn: number): Promise<Checkpoint | null> {
    assertSafeSessionId(session_id);
    const raw = await this.client.get(this.turnKey(session_id, turn));
    if (raw === null) return null;
    return parseCheckpoint(raw);
  }

  async delete(session_id: string): Promise<void> {
    assertSafeSessionId(session_id);
    const pattern = this.prefix + ":" + session_id + ":*";
    const stream = this.client.scanStream({ match: pattern, count: 100 });
    for await (const rawKeys of stream as AsyncIterable<string[]>) {
      if (rawKeys.length > 0) await this.client.del(...rawKeys);
    }
  }

  async list(session_id: string): Promise<Checkpoint[]> {
    assertSafeSessionId(session_id);
    const pattern = this.prefix + ":" + session_id + ":*";
    const latestKey = this.latestKey(session_id);

    const turnKeys: string[] = [];
    const stream = this.client.scanStream({ match: pattern, count: 100 });
    for await (const rawKeys of stream as AsyncIterable<string[]>) {
      for (const k of rawKeys) {
        if (k !== latestKey) turnKeys.push(k);
      }
    }
    if (turnKeys.length === 0) return [];

    // Sort by numeric turn so the `list` contract (ascending order) holds
    // even though SCAN is order-agnostic.
    turnKeys.sort((a, b) => turnFromKey(a) - turnFromKey(b));
    const raws = await this.client.mget(...turnKeys);
    return raws
      .filter((r): r is string => r !== null)
      .map((r) => parseCheckpoint(r));
  }

  /**
   * Connect the underlying Redis client explicitly. Useful in tests and
   * integration setups that want to fail fast on misconfiguration.
   */
  async connect(): Promise<void> {
    // ioredis throws "Redis is already connecting/connected" from any
    // non-idle status, so the guard covers every in-flight and ready state.
    const status = this.client.status;
    if (
      status === "ready" ||
      status === "connect" ||
      status === "connecting" ||
      status === "reconnecting"
    ) {
      return;
    }
    await this.client.connect();
  }

  /** Release the underlying Redis connection. Call on shutdown. */
  async close(): Promise<void> {
    await this.client.quit();
  }

  private turnKey(session_id: string, turn: number): string {
    return this.prefix + ":" + session_id + ":" + turn;
  }

  private latestKey(session_id: string): string {
    return this.prefix + ":" + session_id + ":latest";
  }
}

/** JSON-parse a stored checkpoint and rehydrate Date fields. */
function parseCheckpoint(raw: string): Checkpoint {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const savedAt = parsed.saved_at;
  return {
    ...parsed,
    saved_at: typeof savedAt === "string" ? new Date(savedAt) : new Date(0),
  } as Checkpoint;
}

/** Extract the trailing turn number from a `{prefix}:{session_id}:{turn}` key. */
function turnFromKey(key: string): number {
  const idx = key.lastIndexOf(":");
  return idx === -1 ? 0 : Number(key.slice(idx + 1));
}

function assertSafeSessionId(session_id: string): void {
  if (!SESSION_ID_RE.test(session_id)) {
    throw new Error(
      "RedisCheckpointStore: session_id contains disallowed characters: " +
        JSON.stringify(session_id),
    );
  }
}
