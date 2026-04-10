/** Format a byte count as a human-readable string. */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** Extract a short, human-readable error message from an fs error. */
export function fsErrorMessage(error: unknown, path: string): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return `Not found: ${path}`;
    if (code === "EACCES") return `Permission denied: ${path}`;
    if (code === "EISDIR") return `Is a directory: ${path}`;
    if (code === "ENOTDIR") return `Not a directory: ${path}`;
    if (code === "EEXIST") return `Already exists: ${path}`;
    if (code === "ENOTEMPTY") return `Directory not empty: ${path}`;
    return error.message;
  }
  return String(error);
}
