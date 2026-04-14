/** Format a byte count as a human-readable string. */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const value = bytes / Math.pow(1024, i);
  // eslint-disable-next-line security/detect-object-injection -- index from Math.min/floor, bounded by units.length
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** Extract a short, human-readable error message from an fs error. */
export function fsErrorMessage(error: unknown, path: string): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT")
      return `Cannot access "${path}" — file or directory not found.\nCheck the path exists and is spelled correctly.`;
    if (code === "EACCES")
      return `Permission denied: ${path}\nCheck file permissions or run with appropriate access.`;
    if (code === "EISDIR")
      return `"${path}" is a directory, not a file.\nUse list_directory to explore directories.`;
    if (code === "ENOTDIR")
      return `"${path}" is not a directory.\nCheck the path — a parent component may be a file.`;
    if (code === "EEXIST")
      return `"${path}" already exists.\nUse a different name, or delete the existing one first.`;
    if (code === "ENOTEMPTY")
      return `Directory "${path}" is not empty.\nRemove its contents first, or use a recursive operation.`;
    return `Filesystem error on "${path}": ${error.message}`;
  }
  return String(error);
}
