/**
 * The approval stores `tutti-ai serve` gives its runtime, so a gated tool
 * call (any tool marked `destructive`, by default) pauses for a person
 * instead of failing the run.
 *
 * | Configuration | Approvals and pause checkpoints | Survive a restart |
 * |---|---|---|
 * | `TUTTI_PG_URL` set | `PostgresInterruptStore` and `PostgresCheckpointStore` | yes |
 * | otherwise a usable `TUTTI_STATE_DIR` | files under `interrupts/` and `checkpoints/` there | yes |
 * | otherwise | memory, with a warning at start | no |
 *
 * `TUTTI_STATE_DIR` follows the server image's rules: an absolute path, and
 * one that cannot be created or written falls back to memory with a warning
 * rather than stopping `serve`.
 *
 * Postgres that cannot be reached is not a reason to fall back: its stores
 * fail on first use and the error surfaces there.
 *
 * @module
 */

import { isAbsolute, join } from "node:path";

import {
  MemoryInterruptStore,
  PostgresCheckpointStore,
  PostgresInterruptStore,
} from "@tuttiai/core";
import type { CheckpointStore, InterruptStore } from "@tuttiai/core";
import { FileCheckpointStore, FileInterruptStore } from "@tuttiai/server";

/** Which backend holds the approvals, as the started log line names it. */
export type ServeDurability = "postgres" | "file" | "memory";

/** What {@link buildServeStores} chose. */
export interface ServeStores {
  readonly interruptStore: InterruptStore;
  /** `undefined` on memory: nothing could resume a paused run from it after a restart. */
  readonly checkpointStore?: CheckpointStore;
  readonly durability: ServeDurability;
}

/** Reads one variable, as `SecretsManager.optional` does. */
export type ReadVariable = (key: string) => string | undefined;

/** Reports a choice the operator should know about. `serve` passes its logger. */
export type WarnStores = (message: string) => void;

/** The warning logged once at start when approvals live in memory. */
export const MEMORY_APPROVALS_WARNING =
  "pending approvals will not survive a restart; set TUTTI_PG_URL to keep them in Postgres";

/**
 * Choose where `serve` keeps pending approvals. Built once per process, so
 * a watch-mode reload keeps the approvals already waiting.
 *
 * @param read - Reads `TUTTI_PG_URL`. `serve` passes `SecretsManager.optional`.
 * @param warn - Told once when approvals live in memory.
 * @returns The stores, and which backend they use.
 */
export function buildServeStores(read: ReadVariable, warn: WarnStores): ServeStores {
  const connection_string = read("TUTTI_PG_URL")?.trim();
  if (connection_string) {
    return {
      interruptStore: new PostgresInterruptStore({ connection_string }),
      checkpointStore: new PostgresCheckpointStore({ connection_string }),
      durability: "postgres",
    };
  }
  const files = fileStores(read("TUTTI_STATE_DIR")?.trim(), warn);
  if (files) return files;
  warn(MEMORY_APPROVALS_WARNING);
  return { interruptStore: new MemoryInterruptStore(), durability: "memory" };
}

function fileStores(dir: string | undefined, warn: WarnStores): ServeStores | undefined {
  if (!dir) return undefined;
  if (!isAbsolute(dir) || dir.includes("\0")) {
    warn("TUTTI_STATE_DIR must be an absolute path, such as /state; ignoring it");
    return undefined;
  }
  try {
    return {
      interruptStore: new FileInterruptStore(join(dir, "interrupts")),
      checkpointStore: new FileCheckpointStore(join(dir, "checkpoints")),
      durability: "file",
    };
  } catch {
    // The path is the operator's own; the error text could name others.
    warn("TUTTI_STATE_DIR cannot be written; keeping approvals in memory");
    return undefined;
  }
}
