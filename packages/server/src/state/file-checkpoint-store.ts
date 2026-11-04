/**
 * A file-backed {@link CheckpointStore} for the server image, so a run paused
 * at the approval gate can be resumed after a restart when `TUTTI_STATE_DIR`
 * is set. Internal to `@tuttiai/server`: not exported from its index.
 *
 * @module
 */

import { accessSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";
import { SESSION_ID_PATTERN, createLogger } from "@tuttiai/core";
import type { Checkpoint, CheckpointStore } from "@tuttiai/core";
import type { ChatMessage } from "@tuttiai/types";

import { attempt, removeStrayTemps, writeFileAtomic } from "./atomic-write.js";

const FILE_SUFFIX = ".json";
const TURN_PATTERN = /^(0|[1-9][0-9]{0,8})$/;

const StoredCheckpointSchema = z.object({
  session_id: z.string().regex(SESSION_ID_PATTERN),
  turn: z.number().int().nonnegative(),
  messages: z.array(
    z.object({
      role: z.enum(["user", "assistant"]),
      content: z.union([z.string(), z.array(z.object({ type: z.string() }).passthrough())]),
    }),
  ),
  tool_results: z.array(z.object({ content: z.string(), is_error: z.boolean().optional() })),
  state: z.object({
    next_turn: z.number().int(),
    prompt_tokens_used: z.number(),
    completion_tokens_used: z.number(),
    cost_usd_used: z.number().optional(),
    pending_tool_ids: z.array(z.string()).optional(),
    awaiting_tool_results: z.boolean().optional(),
  }),
  saved_at: z.string().datetime(),
});

type StoredCheckpoint = z.infer<typeof StoredCheckpointSchema>;

/** Reports a checkpoint set aside as unreadable. Gets ids only, never the content. */
export type CorruptCheckpointWarn = (ctx: { session: string; turn: number }, msg: string) => void;

const defaultWarn: CorruptCheckpointWarn = (ctx, msg) => createLogger("tutti-server").warn(ctx, msg);

/**
 * Keeps checkpoints as `<dir>/<session_id>/<turn>.json` (mode 0600), each
 * written by a temporary file renamed into place, insert-or-replace by
 * `(session_id, turn)` as the other stores do. A checkpoint that cannot be
 * read is treated as absent and reported, never thrown. A session id outside
 * `SESSION_ID_PATTERN` never reaches the filesystem. One process per directory.
 */
export class FileCheckpointStore implements CheckpointStore {
  /**
   * @param dir - The directory to keep checkpoints in. Created when missing.
   * @param warn - Where an unreadable checkpoint is reported.
   * @throws {Error} When the directory cannot be created or written, so the caller can fall back.
   */
  constructor(
    private readonly dir: string,
    private readonly warn: CorruptCheckpointWarn = defaultWarn,
  ) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    accessSync(dir, constants.W_OK);
    for (const name of readdirSync(dir)) {
      if (SESSION_ID_PATTERN.test(name)) removeStrayTemps(join(dir, name));
    }
  }

  save(checkpoint: Checkpoint): Promise<void> {
    return attempt(() => {
      if (!SESSION_ID_PATTERN.test(checkpoint.session_id) || !TURN_PATTERN.test(String(checkpoint.turn))) {
        throw new Error("FileCheckpointStore: the session id or turn cannot name a file");
      }
      const sessionDir = join(this.dir, checkpoint.session_id);
      mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
      writeFileAtomic(join(sessionDir, `${checkpoint.turn}${FILE_SUFFIX}`), JSON.stringify(checkpoint));
    });
  }

  async loadLatest(session_id: string): Promise<Checkpoint | null> {
    return (await this.list(session_id)).at(-1) ?? null;
  }

  load(session_id: string, turn: number): Promise<Checkpoint | null> {
    return attempt(() => (this.turns(session_id).includes(turn) ? this.read(session_id, turn) : null));
  }

  delete(session_id: string): Promise<void> {
    return attempt(() => {
      if (SESSION_ID_PATTERN.test(session_id)) rmSync(join(this.dir, session_id), { recursive: true, force: true });
    });
  }

  list(session_id: string): Promise<Checkpoint[]> {
    return attempt(() =>
      this.turns(session_id).flatMap((turn) => this.read(session_id, turn) ?? []),
    );
  }

  /** The turns on disk for a session, ascending. Empty for an id outside the pattern. */
  private turns(session_id: string): number[] {
    const sessionDir = join(this.dir, session_id);
    if (!SESSION_ID_PATTERN.test(session_id) || !existsSync(sessionDir)) return [];
    return readdirSync(sessionDir)
      .map((name) => (name.endsWith(FILE_SUFFIX) ? name.slice(0, -FILE_SUFFIX.length) : ""))
      .filter((stem) => TURN_PATTERN.test(stem))
      .map(Number)
      .sort((a, b) => a - b);
  }

  private read(session_id: string, turn: number): Checkpoint | null {
    try {
      const raw: unknown = JSON.parse(readFileSync(join(this.dir, session_id, `${turn}${FILE_SUFFIX}`), "utf8"));
      const parsed = StoredCheckpointSchema.safeParse(raw);
      if (parsed.success && parsed.data.session_id === session_id && parsed.data.turn === turn) return revive(parsed.data);
    } catch {
      // Bad JSON is reported below like a schema failure, without its content.
    }
    this.warn({ session: session_id, turn }, "Ignoring a checkpoint file that cannot be read");
    return null;
  }
}

function revive(stored: StoredCheckpoint): Checkpoint {
  return {
    ...stored,
    // Safe: the schema checked each message's role and content shape, and the
    // blocks are ones this store wrote from a ChatMessage in the first place.
    messages: stored.messages as ChatMessage[],
    saved_at: new Date(stored.saved_at),
  };
}
