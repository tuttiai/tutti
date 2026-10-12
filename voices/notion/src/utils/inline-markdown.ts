import { MAX_RUNS, richText, styledRuns, type InlineStyle, type RichTextRun } from "./rich-text.js";
import { safeUrl } from "./url-guard.js";

/** Text in one style, before it is cut into runs. */
interface Piece {
  readonly text: string;
  readonly style: InlineStyle;
}

/** What a marker at one position read: its pieces, and where reading carries on. */
interface Match {
  readonly pieces: Piece[];
  readonly next: number;
}

/** Characters a backslash makes literal. */
const ESCAPABLE = new Set(["\\", "*", "_", "~", "`", "[", "]", "(", ")", "|", "!", "#", ">", "-"]);

const WORD = /[\p{L}\p{N}]/u;

/** Whether the character at `index` is a letter or digit; false off either end. */
function isWord(text: string, index: number): boolean {
  return WORD.test(text.charAt(index));
}

/**
 * Where `marker` next closes, from `from`, or -1. Escaped characters are skipped, and for a
 * single `*` or `_` so is a doubled one, which belongs to bold.
 */
function findClose(text: string, from: number, marker: string): number {
  for (let at = from; at < text.length; at += 1) {
    if (text.charAt(at) === "\\") at += 1;
    else if (marker.length === 1 && marker !== "]" && text.startsWith(marker + marker, at)) at += 1;
    else if (text.startsWith(marker, at)) return at;
  }
  return -1;
}

/** `**bold**`, `~~struck~~`, `*italic*` or `_italic_` opening at `at`, with its inside read again. */
function delimited(text: string, at: number, marker: string, style: InlineStyle): Match | undefined {
  const start = at + marker.length;
  const end = findClose(text, start, marker);
  if (end === -1) return undefined;
  const inner = text.slice(start, end);
  if (inner.trim() !== inner || inner.length === 0) return undefined;
  if (marker === "_" && isWord(text, end + 1)) return undefined;
  return { pieces: parse(text.slice(start, end), style), next: end + marker.length };
}

/** `` `code` ``, whose inside is taken as it is. */
function code(text: string, at: number, style: InlineStyle): Match | undefined {
  const end = text.indexOf("`", at + 1);
  if (end <= at + 1) return undefined;
  return { pieces: [{ text: text.slice(at + 1, end), style: { ...style, code: true } }], next: end + 1 };
}

/** `[label](url)`, for an http or https URL that is safe to hand Notion. */
function link(text: string, at: number, style: InlineStyle): Match | undefined {
  if (style.link !== undefined) return undefined;
  const close = findClose(text, at + 1, "]");
  if (close <= at + 1 || text.charAt(close + 1) !== "(") return undefined;
  const end = text.indexOf(")", close + 2);
  const url = end === -1 ? undefined : safeUrl(text.slice(close + 2, end), true);
  if (url === undefined) return undefined;
  return { pieces: parse(text.slice(at + 1, close), { ...style, link: url }), next: end + 1 };
}

/** Whether `_` at `at` can open emphasis: not inside a word such as `snake_case`. */
function opensUnderscore(text: string, at: number): boolean {
  return !isWord(text, at - 1);
}

/** The marker starting at `at`, if one does and it closes. */
function matchAt(text: string, at: number, style: InlineStyle): Match | undefined {
  const char = text.charAt(at);
  if (char === "\\" && ESCAPABLE.has(text.charAt(at + 1))) return { pieces: [{ text: text.charAt(at + 1), style }], next: at + 2 };
  if (char === "`") return code(text, at, style);
  if (char === "[") return link(text, at, style);
  if (text.startsWith("**", at)) return delimited(text, at, "**", { ...style, bold: true });
  if (text.startsWith("~~", at)) return delimited(text, at, "~~", { ...style, strikethrough: true });
  if (char === "*") return delimited(text, at, "*", { ...style, italic: true });
  if (char === "_" && opensUnderscore(text, at)) return delimited(text, at, "_", { ...style, italic: true });
  return undefined;
}

/** Text read into styled pieces; a marker that never closes stays as literal text. */
function parse(text: string, style: InlineStyle): Piece[] {
  const pieces: Piece[] = [];
  let literal = "";
  let at = 0;
  while (at < text.length) {
    const match = matchAt(text, at, style);
    if (match === undefined) {
      literal += text.charAt(at);
      at += 1;
      continue;
    }
    if (literal.length > 0) pieces.push({ text: literal, style });
    literal = "";
    pieces.push(...match.pieces);
    at = match.next;
  }
  if (literal.length > 0) pieces.push({ text: literal, style });
  return pieces;
}

/** Whether two styles are the same, so their pieces can be one run. */
function sameStyle(a: InlineStyle, b: InlineStyle): boolean {
  return a.bold === b.bold && a.italic === b.italic && a.strikethrough === b.strikethrough && a.code === b.code && a.link === b.link;
}

/** Neighbouring pieces in the same style joined, which escapes and nesting leave split. */
function merged(pieces: readonly Piece[]): Piece[] {
  const out: Piece[] = [];
  for (const piece of pieces) {
    const last = out.at(-1);
    if (last !== undefined && sameStyle(last.style, piece.style)) out[out.length - 1] = { text: last.text + piece.text, style: last.style };
    else out.push(piece);
  }
  return out;
}

/**
 * Text with inline markdown as Notion rich-text runs carrying annotations and links.
 *
 * Reads `**bold**`, `*italic*` and `_italic_`, `~~strikethrough~~`, `` `code` `` and
 * `[label](https://url)`, nested where markdown nests them. A marker that never closes stays as
 * literal text, a backslash makes the next marker character literal, and a link to anything but
 * a public http or https address stays as written. Each run stays within Notion's 2,000-character
 * limit; text that would need more than Notion's 100 runs is sent unformatted instead.
 *
 * @param text - One block's text.
 * @returns The runs; none for empty text.
 *
 * @example
 * inlineRichText("ship **today**"); // a plain run, then a bold one
 */
export function inlineRichText(text: string): RichTextRun[] {
  const runs = merged(parse(text, {})).flatMap((piece) => styledRuns(piece.text, piece.style));
  return runs.length > MAX_RUNS ? richText(text) : runs;
}
