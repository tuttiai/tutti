/** Plain-text parser — decodes as UTF-8 and normalizes line endings. */
export function parseText(buffer: Buffer): string {
  return buffer.toString("utf-8").replace(/\r\n/g, "\n");
}
