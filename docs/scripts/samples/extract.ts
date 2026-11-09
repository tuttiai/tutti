import type { Sample, SampleLang } from "./types.js";

const OPENING = /^([ \t]*)(`{3,}|~{3,})(.*)$/;
const HEADING = /^ {0,3}#{1,6}[ \t]+(.*?)[ \t]*#*[ \t]*$/;
const LANGS: Readonly<Record<string, SampleLang>> = { ts: "ts", typescript: "ts", tsx: "tsx" };

interface OpenFence {
  readonly char: string;
  readonly length: number;
  readonly indent: number;
  readonly lang: SampleLang | null;
  readonly startLine: number;
  readonly lines: string[];
}

interface State {
  readonly file: string;
  heading: string;
  fence: OpenFence | null;
  readonly counts: Map<string, number>;
  readonly samples: Sample[];
}

/**
 * Turns heading text into the key used for samples under it: lower case, each run of characters
 * other than a to z and 0 to 9 becomes one `-`, and leading and trailing `-` are removed. It is
 * deterministic, which is all a key needs; it is not meant to match the site's anchor slugs.
 *
 * @param text - The heading text after the `#` marks.
 * @returns The slug, possibly empty.
 */
export function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * The language a fence's info string asks for, when it is one this check counts: the first word,
 * in any case, must be `ts`, `tsx` or `typescript`. Anything after it (`title="..."`, `{1,3}`,
 * `ins=`) is ignored.
 *
 * @param info - Everything after the fence characters on the opening line.
 * @returns `ts`, `tsx`, or null for any other language or none.
 */
export function langOf(info: string): SampleLang | null {
  const word = info.trim().split(/[\s{]/, 1)[0] ?? "";
  return LANGS[word.toLowerCase()] ?? null;
}

function openFence(line: string, lineNo: number): OpenFence | null {
  const match = OPENING.exec(line);
  if (match === null) return null;
  const [, indent = "", marks = "", info = ""] = match;
  // A backtick fence's info string may not contain a backtick (CommonMark), so `` `a` `` is inline.
  if (marks.startsWith("`") && info.includes("`")) return null;
  return {
    char: marks.charAt(0),
    length: marks.length,
    indent: indent.length,
    lang: langOf(info),
    startLine: lineNo + 1,
    lines: [],
  };
}

function closes(fence: OpenFence, line: string): boolean {
  const trimmed = line.trim();
  return trimmed.length >= fence.length && trimmed === fence.char.repeat(trimmed.length);
}

function dedent(line: string, indent: number): string {
  let cut = 0;
  while (cut < indent && (line[cut] === " " || line[cut] === "\t")) cut += 1;
  return line.slice(cut);
}

function finish(state: State, fence: OpenFence): void {
  state.fence = null;
  if (fence.lang === null) return;
  const index = (state.counts.get(state.heading) ?? 0) + 1;
  state.counts.set(state.heading, index);
  state.samples.push({
    file: state.file,
    heading: state.heading,
    index,
    lang: fence.lang,
    startLine: fence.startLine,
    indent: fence.indent,
    code: fence.lines.map((line) => dedent(line, fence.indent)).join("\n"),
  });
}

function step(state: State, line: string, lineNo: number): void {
  const fence = state.fence;
  if (fence !== null) {
    if (closes(fence, line)) finish(state, fence);
    else fence.lines.push(line);
    return;
  }
  const opened = openFence(line, lineNo);
  if (opened !== null) {
    state.fence = opened;
    return;
  }
  const heading = HEADING.exec(line);
  if (heading !== null) state.heading = slugify(heading[1] ?? "");
}

/** The index of the first line after YAML front matter, or 0 when there is none. */
function bodyStart(lines: readonly string[]): number {
  if (lines[0]?.trim() !== "---") return 0;
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
  return end === -1 ? 0 : end + 1;
}

/**
 * Pulls every ts/tsx fenced block out of one .mdx file. Fences may use three or more backticks
 * or tildes and may be indented (inside lists or JSX such as `<TabItem>`); a block closes at a
 * line of the same character at least as long as its opening fence, and an unclosed block runs
 * to the end of the file, as in CommonMark. Headings inside any fenced block and `#` lines in
 * front matter are not headings.
 *
 * @param file - The file's path relative to the repository root, with forward slashes.
 * @param text - The file's content.
 * @returns The counted blocks, in file order.
 */
export function extractSamples(file: string, text: string): Sample[] {
  const lines = text.split(/\r?\n/);
  const state: State = { file, heading: "", fence: null, counts: new Map(), samples: [] };
  for (let i = bodyStart(lines); i < lines.length; i += 1) step(state, lines[i] ?? "", i + 1);
  if (state.fence !== null) finish(state, state.fence);
  return state.samples;
}
