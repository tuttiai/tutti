/** The tail of a log, and whether anything before it was dropped. */
export interface LogTail {
  text: string;
  lines: number;
  totalLines: number;
  truncated: boolean;
}

/**
 * Turn the body Octokit hands back for a log download into text.
 *
 * Octokit returns a string for a `text/*` response and an `ArrayBuffer` for
 * anything else, depending on the content type the log host sends.
 *
 * @param data - The `data` field of the Octokit response.
 * @returns The log as text, or `undefined` when the body is neither form.
 */
export function decodeLogBody(data: unknown): string | undefined {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
  return undefined;
}

/**
 * Keep the last `maxLines` lines of a log, then the last `maxChars` characters of those.
 *
 * Failures are reported at the end of a CI log, so the tail is the useful
 * part. The character cap bounds the result even when single lines are huge.
 *
 * @param log - The whole log.
 * @param maxLines - How many trailing lines to keep.
 * @param maxChars - Upper bound on the characters returned.
 * @returns The kept text with counts, and whether anything was dropped.
 */
export function tailLog(log: string, maxLines: number, maxChars: number): LogTail {
  const all = log.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n");
  const kept = all.slice(-maxLines);
  let text = kept.join("\n");
  const charCut = text.length > maxChars;
  if (charCut) text = text.slice(text.length - maxChars);
  const lines = charCut ? text.split("\n").length : kept.length;
  return { text, lines, totalLines: all.length, truncated: charCut || kept.length < all.length };
}
