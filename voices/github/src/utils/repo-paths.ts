/** Most entries (files plus deletions) one `commit_files` call may carry. */
export const MAX_COMMIT_ENTRIES = 100;

/**
 * Largest file content, in UTF-8 bytes, one `commit_files` entry may carry.
 * GitHub refuses inline tree content above 1 MB.
 */
export const MAX_FILE_BYTES = 1024 * 1024;

/** One file to write in a commit: its repository path and full new content. */
export interface FileChange {
  path: string;
  content: string;
}

function hasControlCharacter(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Check one repository-relative path for a git tree.
 *
 * This is not `PathSanitizer`: that resolves against the local filesystem,
 * whereas a tree path never touches the disk and must be judged as text.
 * Refuses absolute paths, backslashes, empty, `.` or `..` segments, control
 * characters, and any `.git` segment, which git itself treats as reserved.
 *
 * @param path - The path as the caller supplied it.
 * @returns A reason the path is refused, or `null` when it is acceptable.
 */
export function repoPathProblem(path: string): string | null {
  if (path.length === 0) return "path is empty";
  if (path.startsWith("/")) return "absolute paths are not allowed; use a path relative to the repository root";
  if (path.includes("\\")) return "backslashes are not allowed; separate segments with '/'";
  if (hasControlCharacter(path)) return "control characters are not allowed";
  for (const segment of path.split("/")) {
    if (segment === "") return "empty segments ('//' or a trailing '/') are not allowed";
    if (segment === "." || segment === "..") return "'.' and '..' segments are not allowed";
    if (segment.toLowerCase() === ".git") return "paths inside .git are not allowed";
  }
  return null;
}

/**
 * Validate a whole `commit_files` change set before any request is made.
 *
 * @param files - Files to write.
 * @param deletions - Paths to delete.
 * @returns A reason the change set is refused, or `null` when it is acceptable.
 */
export function changeSetProblem(files: readonly FileChange[], deletions: readonly string[]): string | null {
  const total = files.length + deletions.length;
  if (total === 0) return "Nothing to commit: pass at least one entry in files or deletions.";
  if (total > MAX_COMMIT_ENTRIES) {
    return `Too many entries: ${total} (at most ${MAX_COMMIT_ENTRIES} files and deletions per commit). Split the change into several commits.`;
  }
  const seen = new Set<string>();
  for (const path of [...files.map((f) => f.path), ...deletions]) {
    const problem = repoPathProblem(path);
    if (problem !== null) return `Invalid path "${path}": ${problem}.`;
    if (seen.has(path)) return `Duplicate path "${path}": each path may appear once across files and deletions.`;
    seen.add(path);
  }
  for (const file of files) {
    const bytes = Buffer.byteLength(file.content, "utf8");
    if (bytes > MAX_FILE_BYTES) {
      return `File "${file.path}" is ${bytes} bytes; inline content is limited to ${MAX_FILE_BYTES} bytes (1 MB).`;
    }
  }
  return null;
}
