/**
 * Where the image keeps pending approvals and the turns their runs paused
 * at, so approving after a restart resumes the run. Kept apart from
 * `start.ts` so it can be tested without starting a process.
 *
 * | Configuration | Approvals and pause checkpoints | Survive a restart |
 * |---|---|---|
 * | `TUTTI_PG_URL` set | Postgres tables of `PostgresInterruptStore` and `PostgresCheckpointStore` | yes |
 * | otherwise a usable `TUTTI_STATE_DIR` | files under `interrupts/` and `checkpoints/` there | yes |
 * | neither | memory, with a warning at start | no |
 *
 * Postgres that cannot be reached is not a reason to fall back: its stores
 * fail on first use and the error surfaces there.
 */

import { PostgresCheckpointStore, PostgresInterruptStore, MemoryInterruptStore } from "@tuttiai/core";
import type { CheckpointStore, InterruptStore } from "@tuttiai/core";

import type { StartStatePaths } from "./start-state.js";
import { describeError } from "./state/atomic-write.js";
import { FileCheckpointStore } from "./state/file-checkpoint-store.js";
import { FileInterruptStore } from "./state/file-interrupt-store.js";

/** Which backend holds the image's approvals, as the started log line names it. */
export type StartDurability = "postgres" | "file" | "memory";

/** The stores the image's runtime gets for approvals. */
export interface StartStores {
  readonly interrupts: InterruptStore;
  /** `undefined` on memory: nothing could resume a paused run from it after a restart. */
  readonly checkpoints: CheckpointStore | undefined;
  readonly durability: StartDurability;
}

/** Reports a store set aside. `start.ts` passes its logger. Never given a record. */
export type WarnStores = (context: Record<string, string>, message: string) => void;

/** The warning logged once at start when approvals live in memory. */
export const MEMORY_APPROVALS_WARNING =
  "pending approvals will not survive a restart; set TUTTI_STATE_DIR or configure Postgres";

/**
 * The memory stores the image used before approvals were durable.
 *
 * @returns An in-memory interrupt store and no checkpoint store.
 */
export function memoryStartStores(): StartStores {
  return { interrupts: new MemoryInterruptStore(), checkpoints: undefined, durability: "memory" };
}

/**
 * Choose the image's approval stores: Postgres, then files, then memory.
 *
 * @param pg_url - `TUTTI_PG_URL`, or `undefined`.
 * @param state - The usable state directory, or `undefined`.
 * @param warn - Told when approvals end up in memory, and why.
 * @returns The stores, never throwing.
 *
 * @example
 * const stores = buildStartStores(SecretsManager.optional("TUTTI_PG_URL"), state, (c, m) => logger.warn(c, m));
 */
export function buildStartStores(
  pg_url: string | undefined,
  state: StartStatePaths | undefined,
  warn: WarnStores,
): StartStores {
  if (pg_url !== undefined && pg_url.trim() !== "") {
    const connection_string = pg_url.trim();
    return {
      interrupts: new PostgresInterruptStore({ connection_string }),
      checkpoints: new PostgresCheckpointStore({ connection_string }),
      durability: "postgres",
    };
  }
  const files = state === undefined ? undefined : fileStores(state, warn);
  if (files) return files;
  warn({ durability: "memory" }, MEMORY_APPROVALS_WARNING);
  return memoryStartStores();
}

function fileStores(state: StartStatePaths, warn: WarnStores): StartStores | undefined {
  try {
    return {
      interrupts: new FileInterruptStore(state.interrupts),
      checkpoints: new FileCheckpointStore(state.checkpoints),
      durability: "file",
    };
  } catch (error) {
    warn({ dir: state.interrupts, error: describeError(error) }, "Cannot keep approvals on disk");
    return undefined;
  }
}
