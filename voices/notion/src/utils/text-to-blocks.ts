/** Notion refuses a text run longer than this, so longer text is split into several runs. */
const RUN_LIMIT = 2_000;

/** Notion accepts at most this many blocks in one request. */
export const MAX_BLOCKS_PER_REQUEST = 100;

/** Code languages Notion accepts that are worth recognising from a fence; others become plain text. */
const LANGUAGES = new Set([
  "bash", "c", "c++", "c#", "css", "diff", "docker", "go", "html", "java", "javascript", "json",
  "kotlin", "markdown", "php", "python", "ruby", "rust", "shell", "sql", "swift", "typescript", "yaml",
]);

/** A block as Notion's create and append endpoints take it. */
export type BlockInput = Record<string, unknown>;

/**
 * Text as Notion rich-text runs, each within Notion's 2,000-character limit.
 *
 * @param text - The text.
 * @returns The runs; none for empty text.
 */
export function richText(text: string): { type: "text"; text: { content: string } }[] {
  const out: { type: "text"; text: { content: string } }[] = [];
  for (let start = 0; start < text.length; start += RUN_LIMIT) {
    out.push({ type: "text", text: { content: text.slice(start, start + RUN_LIMIT) } });
  }
  return out;
}

/** A block whose payload is rich text, plus any extra payload fields. */
function textBlock(type: string, text: string, extra: Record<string, unknown> = {}): BlockInput {
  return { object: "block", type, [type]: { rich_text: richText(text), ...extra } };
}

const TODO = /^[-*] \[( |x|X)\] (.*)$/;
const BULLET = /^[-*] (.*)$/;
const NUMBERED = /^\d{1,9}[.)] (.*)$/;
const HEADING = /^(#{1,3}) (.*)$/;

/** One line of text as one block. */
function lineToBlock(line: string): BlockInput {
  const todo = TODO.exec(line);
  if (todo !== null) return textBlock("to_do", todo[2] ?? "", { checked: todo[1] !== " " });
  const heading = HEADING.exec(line);
  if (heading !== null) return textBlock(`heading_${heading[1]?.length ?? 1}`, heading[2] ?? "");
  const bullet = BULLET.exec(line);
  if (bullet !== null) return textBlock("bulleted_list_item", bullet[1] ?? "");
  const numbered = NUMBERED.exec(line);
  if (numbered !== null) return textBlock("numbered_list_item", numbered[1] ?? "");
  if (line.startsWith("> ")) return textBlock("quote", line.slice(2));
  if (line === "---") return { object: "block", type: "divider", divider: {} };
  return textBlock("paragraph", line);
}

/** A fenced code block's language, as one Notion accepts. */
function languageOf(fence: string): string {
  const named = fence.slice(3).trim().toLowerCase();
  return LANGUAGES.has(named) ? named : "plain text";
}

/**
 * Convert markdown-like text into Notion blocks.
 *
 * Each non-blank line becomes one block: `#`, `##` and `###` headings, `-` or `*` bullets,
 * `1.` numbered items, `- [ ]` and `- [x]` to-dos, `>` quotes, `---` dividers and paragraphs.
 * A fenced code block becomes one code block. Blank lines only separate. Inline markdown such as
 * `**bold**` is kept as literal text.
 *
 * @param text - The text to convert.
 * @returns The blocks, in order.
 *
 * @example
 * textToBlocks("# Plan\n- ship it"); // a heading_1 and a bulleted_list_item
 */
export function textToBlocks(text: string): BlockInput[] {
  const blocks: BlockInput[] = [];
  let fence: { language: string; lines: string[] } | undefined;
  for (const line of text.replaceAll("\r\n", "\n").split("\n")) {
    if (fence !== undefined) {
      if (line.trimEnd() === "```") {
        blocks.push(textBlock("code", fence.lines.join("\n"), { language: fence.language }));
        fence = undefined;
      } else fence.lines.push(line);
    } else if (line.startsWith("```")) fence = { language: languageOf(line), lines: [] };
    else if (line.trim().length > 0) blocks.push(lineToBlock(line.trimEnd()));
  }
  if (fence !== undefined) blocks.push(textBlock("code", fence.lines.join("\n"), { language: fence.language }));
  return blocks;
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
