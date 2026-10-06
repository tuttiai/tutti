/** Most lines one `get_file_contents` call may ask for. */
export const MAX_PAGE_LINES = 5000;

/**
 * Most characters one page returns, whatever `limit` says. Kept well under the
 * runtime's per-result cap, so a page is never cut in the middle on its way to
 * the model: a cut page looks whole, and a file written back from one loses
 * everything after the cut.
 */
export const MAX_PAGE_CHARS = 40_000;

/** Which lines to return: `offset` is the 1-based first line. */
export interface PageWindow {
  offset: number;
  limit?: number | undefined;
}

/** One page of a file, and where it sits in the whole. */
export interface FilePage {
  text: string;
  first: number;
  last: number;
  totalLines: number;
  partial: boolean;
}

/**
 * Split text into lines, without counting the empty string after a final newline as a line.
 *
 * @param text - The whole file.
 * @returns Its lines, without their newlines.
 */
export function linesOf(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  return lines;
}

/**
 * Take one page of a file: from `offset`, at most `limit` lines and at most
 * {@link MAX_PAGE_CHARS} characters, ending on a whole line unless one line
 * alone is longer than the character cap.
 *
 * @param text - The whole file.
 * @param window - The first line and how many lines to take.
 * @returns The page, with `partial` set when any of the file was left out.
 */
export function pageOf(text: string, window: PageWindow): FilePage {
  const lines = linesOf(text);
  const start = window.offset - 1;
  const end = Math.min(lines.length, window.limit === undefined ? lines.length : start + window.limit);
  const taken: string[] = [];
  let chars = 0;
  for (let i = start; i < end; i++) {
    const line = lines[i] ?? "";
    const cost = line.length + 1;
    if (chars + cost > MAX_PAGE_CHARS) {
      if (taken.length === 0) taken.push(line.slice(0, MAX_PAGE_CHARS));
      break;
    }
    taken.push(line);
    chars += cost;
  }
  const first = taken.length === 0 ? 0 : window.offset;
  const last = taken.length === 0 ? 0 : window.offset + taken.length - 1;
  const cutLine = taken.length === 1 && (lines[start]?.length ?? 0) > MAX_PAGE_CHARS;
  const partial = first > 1 || last < lines.length || cutLine || (taken.length === 0 && lines.length > 0);
  return { text: taken.join("\n"), first, last, totalLines: lines.length, partial };
}

/**
 * The line that opens every file read, so a caller always knows whether it
 * holds the whole file and, when it does not, where to read on from.
 *
 * @param where - The path and ref, e.g. `src/a.ts @ main`.
 * @param page - The page returned.
 * @param bytes - The whole file's size in bytes.
 * @returns One bracketed line.
 */
export function pageHeader(where: string, page: FilePage, bytes: number): string {
  const lines = page.totalLines.toLocaleString("en-US");
  const size = `${bytes.toLocaleString("en-US")} bytes`;
  if (page.totalLines === 0) return `[${where}: empty file, ${size}]`;
  if (page.first === 0) return `[${where}: no lines from that offset; the file has ${lines} lines, ${size}]`;
  const span = `lines ${page.first}-${page.last} of ${lines} (${size})`;
  if (!page.partial) return `[${where}: ${span}, complete]`;
  const next = page.last < page.totalLines ? `next offset=${page.last + 1}` : "the last line was cut at the character cap";
  return `[${where}: ${span}, PARTIAL: ${next}. Do not write this page back as the whole file; use edit_file.]`;
}
