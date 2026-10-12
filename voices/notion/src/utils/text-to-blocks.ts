import { isNestedItem, lineToBlock, LIST_ITEM_TYPES, type BlockInput } from "./line-blocks.js";
import { readQuote } from "./quote-blocks.js";
import { richText } from "./rich-text.js";
import { MAX_CHILDREN, readTable } from "./table-blocks.js";

export type { BlockInput } from "./line-blocks.js";
export { richText } from "./rich-text.js";

/** Notion accepts at most this many blocks in one request. */
export const MAX_BLOCKS_PER_REQUEST = 100;

/**
 * Code languages Notion accepts that are worth recognising from a fence; others become plain
 * text. `mermaid` makes Notion draw the block as a diagram.
 */
const LANGUAGES = new Set([
  "bash", "c", "c++", "c#", "css", "diff", "docker", "go", "graphql", "html", "java", "javascript", "json",
  "kotlin", "markdown", "mermaid", "php", "python", "ruby", "rust", "scss", "shell", "sql", "swift",
  "typescript", "xml", "yaml",
]);

/** Common short names for the languages above. */
const ALIASES = new Map([
  ["js", "javascript"], ["ts", "typescript"], ["py", "python"], ["sh", "shell"], ["zsh", "shell"],
  ["yml", "yaml"], ["md", "markdown"], ["dockerfile", "docker"], ["cpp", "c++"], ["csharp", "c#"],
]);

/** One block read from the text, and whether it is indented under the list item above it. */
interface Entry {
  readonly block: BlockInput;
  readonly nested: boolean;
}

/** What reading from one line gave: the entries, and the line to carry on from. */
interface Read {
  readonly entries: Entry[];
  readonly next: number;
}

/** A fenced code block's language, as one Notion accepts. */
function languageOf(fence: string): string {
  const named = fence.slice(3).trim().toLowerCase();
  const language = ALIASES.get(named) ?? named;
  return LANGUAGES.has(language) ? language : "plain text";
}

/** A fenced code block from its opening line to its closing one, or to the end if it never closes. */
function readFence(raw: readonly string[], start: number): Read {
  const language = languageOf(raw.at(start) ?? "");
  const body: string[] = [];
  let next = start + 1;
  for (let line = raw.at(next); line !== undefined && line.trimEnd() !== "```"; line = raw.at(next)) {
    body.push(line);
    next += 1;
  }
  const block = { object: "block", type: "code", code: { rich_text: richText(body.join("\n")), language } };
  return { entries: [{ block, nested: false }], next: next + 1 };
}

/** The block or blocks starting at line `at`. */
function readAt(raw: readonly string[], lines: readonly string[], at: number): Read {
  const line = lines.at(at) ?? "";
  if ((raw.at(at) ?? "").startsWith("```")) return readFence(raw, at);
  if (line.trim().length === 0) return { entries: [], next: at + 1 };
  const table = readTable(lines, at);
  if (table !== undefined) return { entries: table.blocks.map((block) => ({ block, nested: false })), next: table.next };
  const quote = readQuote(lines, at);
  if (quote !== undefined) return { entries: [{ block: quote.block, nested: false }], next: quote.next };
  const nested = isNestedItem(line);
  return { entries: [{ block: lineToBlock(nested ? line.trim() : line), nested }], next: at + 1 };
}

/** A list item with its nested items set as its children. */
function withChildren(block: BlockInput, children: BlockInput[]): BlockInput {
  const type = typeof block.type === "string" ? block.type : "";
  const payload: unknown = new Map(Object.entries(block)).get(type);
  if (children.length === 0 || typeof payload !== "object" || payload === null) return block;
  return { ...block, [type]: { ...payload, children } };
}

/** Nested items moved under the list item above them; one with no such item stays at the top. */
function nest(entries: readonly Entry[]): BlockInput[] {
  const out: BlockInput[] = [];
  let parent: { readonly index: number; readonly children: BlockInput[] } | undefined;
  const close = (): void => {
    const block = parent === undefined ? undefined : out.at(parent.index);
    if (parent !== undefined && block !== undefined) out[parent.index] = withChildren(block, parent.children);
  };
  for (const { block, nested } of entries) {
    if (nested && parent !== undefined && parent.children.length < MAX_CHILDREN) {
      parent.children.push(block);
      continue;
    }
    close();
    out.push(block);
    parent = LIST_ITEM_TYPES.has(String(block.type)) ? { index: out.length - 1, children: [] } : undefined;
  }
  close();
  return out;
}

/**
 * Convert markdown-like text into Notion blocks.
 *
 * Lines become `#`, `##` and `###` headings, `-` or `*` bullets, `1.` numbered items, `- [ ]`
 * and `- [x]` to-dos, `---` dividers and paragraphs. A list item indented by two or more spaces
 * goes under the item above it, one level deep. A fenced code block becomes one code block, and
 * a ```` ```mermaid ```` fence a diagram. A GitHub-style table becomes a table, split every 99
 * rows. Consecutive `>` lines become one quote, or a callout when the first is `[!NOTE]`,
 * `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]` or `[!CAUTION]`. A line that is only
 * `![caption](https://...)` becomes an image, and one that is only an https URL a bookmark,
 * when the URL is public. Text takes `**bold**`, `*italic*`, `~~strikethrough~~`, `` `code` ``
 * and `[links](https://...)`. Blank lines only separate.
 *
 * @param text - The text to convert.
 * @returns The top-level blocks, in order.
 *
 * @example
 * textToBlocks("# Plan\n- ship **it**"); // a heading_1 and a bulleted_list_item with a bold run
 */
export function textToBlocks(text: string): BlockInput[] {
  const raw = text.replaceAll("\r\n", "\n").split("\n");
  const lines = raw.map((line) => line.trimEnd());
  const entries: Entry[] = [];
  for (let at = 0; at < raw.length; ) {
    const read = readAt(raw, lines, at);
    entries.push(...read.entries);
    at = read.next;
  }
  return nest(entries);
}

/**
 * The refusal for text that converts to more blocks than one request carries.
 *
 * @param count - How many blocks the text converted to.
 * @returns The sentence, with the fix.
 */
export function tooManyBlocksMessage(count: number): string {
  return `The content converts to ${count} blocks, and Notion takes at most ${MAX_BLOCKS_PER_REQUEST} in one request. Split it and send the rest with append_to_page.`;
}
