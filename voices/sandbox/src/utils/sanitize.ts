/** Maximum bytes for stdout or stderr before truncation. */
export const MAX_OUTPUT_BYTES = 10_240; // 10 KB

/**
 * Strip ANSI escape codes (colors, cursor movement, etc.) from a
 * string so that tool output is plain text.
 */
export function stripAnsi(text: string): string {
  // Covers SGR, CSI, OSC, and common escape sequences.
  return text.replace(
    /\x1b\[[0-9;]*[A-Za-z]|\x1b\].*?(?:\x07|\x1b\\)|\x1b[()][AB012]|\x1b[@-_]/g,
    "",
  );
}

/**
 * Truncate a string to `max` bytes (not characters) and report
 * whether truncation occurred.
 *
 * @returns `[truncatedString, wasTruncated]`
 */
export function truncateOutput(
  text: string,
  max: number = MAX_OUTPUT_BYTES,
): [string, boolean] {
  const buf = Buffer.from(text, "utf-8");
  if (buf.length <= max) return [text, false];

  // Slice at byte boundary then decode — may cut a multi-byte char,
  // which toString("utf-8") replaces with U+FFFD. Acceptable for logs.
  const truncated = buf.subarray(0, max).toString("utf-8");
  return [truncated + "\n[…output truncated to 10 KB]", true];
}

/**
 * Redact the host working directory from error messages so that
 * absolute paths are never leaked to end users.
 */
export function redactPaths(text: string, workDir: string): string {
  if (!workDir) return text;
  return text.replaceAll(workDir, "<workdir>");
}
