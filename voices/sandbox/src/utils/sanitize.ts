/** Maximum bytes kept of stdout or of stderr; the middle of longer output is left out. */
export const MAX_OUTPUT_BYTES = 10_240; // 10 KB

/**
 * Strip ANSI escape codes (colors, cursor movement, etc.) from a
 * string so that tool output is plain text.
 *
 * The regex uses bounded character classes (no unbounded `.*?`) to
 * avoid ReDoS on adversarial input.
 */
export function stripAnsi(text: string): string {
  return text.replace(
    // SGR / CSI: \x1b[ … letter
    // OSC:       \x1b] … BEL  or  \x1b] … ST  (bounded: [^\x07\x1b] avoids backtracking)
    // Charset:   \x1b( or \x1b) followed by charset designator
    // Fe:        \x1b followed by @ through _
    /\x1b\[[0-9;]*[A-Za-z]|\x1b][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][AB012]|\x1b[@-_]/g,
    "",
  );
}

/**
 * Share of the byte budget kept from the start of the output. The rest
 * comes from the end, because that is where a failing command puts its
 * error and a test runner its summary.
 */
export const HEAD_FRACTION = 0.3;

/**
 * How far, as a share of a kept segment, a cut may move to land on a
 * line break instead of mid-line.
 */
const LINE_SNAP_FRACTION = 0.1;

/** Whether the byte at `index` continues a multi-byte UTF-8 character (0b10xxxxxx). */
function isContinuation(buf: Buffer, index: number): boolean {
  return ((buf.at(index) ?? 0) & 0xc0) === 0x80;
}

/** Move `index` back to the first byte of the UTF-8 character it is in. */
function charStartBack(buf: Buffer, index: number): number {
  let i = index;
  while (i > 0 && isContinuation(buf, i)) i--;
  return i;
}

/** Move `index` forward to the first byte of the next whole UTF-8 character. */
function charStartForward(buf: Buffer, index: number): number {
  let i = index;
  while (i < buf.length && isContinuation(buf, i)) i++;
  return i;
}

/** End of the head: just after a line break near `limit`, if there is one. */
function headCut(buf: Buffer, limit: number): number {
  // A negative offset would make lastIndexOf search from the end.
  if (limit <= 0) return 0;
  const nl = buf.lastIndexOf(0x0a, limit - 1);
  const floor = limit - Math.floor(limit * LINE_SNAP_FRACTION);
  return nl >= floor ? nl + 1 : charStartBack(buf, limit);
}

/** Start of the tail: just after a line break near `start`, if there is one. */
function tailCut(buf: Buffer, start: number): number {
  const span = buf.length - start;
  const nl = buf.indexOf(0x0a, start);
  const ceiling = start + Math.floor(span * LINE_SNAP_FRACTION);
  return nl >= 0 && nl < ceiling ? nl + 1 : charStartForward(buf, start);
}

/**
 * Cut a string to about `max` bytes (not characters), keeping its start
 * and its end, and report whether anything was cut.
 *
 * Roughly {@link HEAD_FRACTION} of the budget is kept from the start and
 * the rest from the end, each cut moved to a nearby line break where there
 * is one and never splitting a UTF-8 character. The part left out is
 * replaced by a line saying how many characters it held.
 *
 * @param text - The output to cut.
 * @param max - Byte budget for the kept text, excluding the marker line.
 * @returns `[cutString, wasCut]`
 *
 * @example
 * const [out, cut] = truncateOutput(log, 10_240);
 * // out: first ~3 KB, "[… 51234 characters left out …]", last ~7 KB
 */
export function truncateOutput(
  text: string,
  max: number = MAX_OUTPUT_BYTES,
): [string, boolean] {
  const buf = Buffer.from(text, "utf-8");
  if (buf.length <= max) return [text, false];

  const headEnd = headCut(buf, Math.floor(max * HEAD_FRACTION));
  const tailStart = Math.max(headEnd, tailCut(buf, buf.length - (max - headEnd)));
  const head = buf.subarray(0, headEnd).toString("utf-8");
  const tail = buf.subarray(tailStart).toString("utf-8");
  const omitted = buf.subarray(headEnd, tailStart).toString("utf-8").length;

  const sep = head === "" || head.endsWith("\n") ? "" : "\n";
  const marker = `[… ${omitted} characters left out …]`;
  const after = tail === "" || tail.startsWith("\n") ? "" : "\n";
  return [head + sep + marker + after + tail, true];
}

/**
 * Redact the host working directory from error messages so that
 * absolute paths are never leaked to end users.
 */
export function redactPaths(text: string, workDir: string): string {
  if (!workDir) return text;
  return text.replaceAll(workDir, "<workdir>");
}
