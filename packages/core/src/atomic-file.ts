import { randomUUID } from "node:crypto";
import { renameSync, rmSync, writeFileSync } from "node:fs";

/** Suffix of the temporary file a write goes to before it is renamed into place. */
export const TEMP_SUFFIX = ".tmp";

/**
 * Write a file so a reader only ever sees the old content or the new, never
 * half of it: the data goes to a temporary file beside the target, which is
 * then renamed over it. A rename within one directory is atomic on POSIX
 * filesystems, so a crash mid-write leaves at most a stray temporary file.
 *
 * @param path - The file to write. Its directory must exist.
 * @param data - The new content.
 * @throws {Error} When the write or the rename fails. The temporary file is removed first.
 *
 * @example
 * writeFileAtomic("/state/sessions/abc.json", JSON.stringify(session));
 */
export function writeFileAtomic(path: string, data: string): void {
  const temp = `${path}.${randomUUID()}${TEMP_SUFFIX}`;
  try {
    // 0o600: a session holds a conversation, which is nobody else's to read.
    writeFileSync(temp, data, { encoding: "utf8", mode: 0o600 });
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}
