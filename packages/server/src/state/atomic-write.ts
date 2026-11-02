/**
 * Atomic file writes for the server's state stores, a local copy of the
 * helper `@tuttiai/core` keeps unexported for `FileSessionStore`.
 *
 * @module
 */

import { randomUUID } from "node:crypto";
import { readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Suffix of the temporary file a write goes to before it is renamed into place. */
export const TEMP_SUFFIX = ".tmp";

/**
 * Write a file so a reader only ever sees the old content or the new: the
 * data goes to a temporary file beside the target, which is then renamed
 * over it. A crash mid-write leaves at most a stray temporary file.
 *
 * @param path - The file to write. Its directory must exist.
 * @param data - The new content.
 * @throws {Error} When the write or the rename fails. The temporary file is removed first.
 */
export function writeFileAtomic(path: string, data: string): void {
  const temp = `${path}.${randomUUID()}${TEMP_SUFFIX}`;
  try {
    // 0o600: approvals and checkpoints hold tool arguments, which are nobody else's to read.
    writeFileSync(temp, data, { encoding: "utf8", mode: 0o600 });
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/**
 * Remove the temporary files an interrupted write left in a directory.
 *
 * @param dir - The directory to clean. Only its own entries are looked at.
 */
export function removeStrayTemps(dir: string): void {
  for (const name of readdirSync(dir)) {
    if (name.endsWith(TEMP_SUFFIX)) rmSync(join(dir, name), { force: true });
  }
}

/**
 * Run synchronous file work as a promise, so a store method rejects rather
 * than throws.
 *
 * @param work - The work.
 * @returns Its result, or a rejection with what it threw as an `Error`.
 */
export function attempt<T>(work: () => T): Promise<T> {
  try {
    return Promise.resolve(work());
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(describeError(error)));
  }
}

/**
 * The message of an unknown thrown value, for a log line.
 *
 * @param error - Anything caught.
 * @returns Its message, never its stack or a file's content.
 */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
