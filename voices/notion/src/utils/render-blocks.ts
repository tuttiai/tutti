import { z } from "zod";

import type { Block } from "../notion-schemas.js";
import { markdownText } from "./render-rich-text.js";
import { calloutText, mediaText, payloadOf, quoteText, tableText } from "./render-special.js";

const PayloadSchema = z
  .object({
    rich_text: z.unknown().optional(),
    checked: z.boolean().optional(),
    language: z.string().optional(),
    title: z.string().optional(),
    url: z.string().optional(),
  })
  .passthrough();

type Payload = z.infer<typeof PayloadSchema>;

/** Children read for some blocks, keyed by the parent block's id. */
export type ChildBlocks = ReadonlyMap<string, readonly Block[]>;

/** Line prefixes for the block types that are one line of rich text. */
const PREFIXES = new Map<string, string>([
  ["paragraph", ""],
  ["heading_1", "# "],
  ["heading_2", "## "],
  ["heading_3", "### "],
  ["bulleted_list_item", "- "],
  ["toggle", "- "],
]);

/** Block types that are only a link. */
const LINKS = new Set(["bookmark", "embed", "link_preview"]);

/** Block types whose payload is a hosted or external file. */
const MEDIA = new Set(["image", "file", "pdf", "video", "audio"]);

/** A block of a type with no markdown of its own. */
function otherText(block: Block, payload: Payload): string {
  if (block.type === "divider") return "---";
  if (block.type === "child_page" || block.type === "child_database") {
    return `[${block.type}: ${payload.title ?? "(untitled)"} (${block.id})]`;
  }
  const text = markdownText(payload.rich_text);
  const extra = text.length > 0 ? text : (payload.url ?? "");
  return extra.length > 0 ? `[${block.type}] ${extra}` : `[${block.type}]`;
}

/** A block whose markdown is not a prefix on its text, or `undefined` for one that is. */
function structuredText(block: Block, raw: unknown, payload: Payload): string | undefined {
  if (block.type === "quote") return quoteText(markdownText(payload.rich_text));
  if (block.type === "callout") return calloutText(raw);
  if (LINKS.has(block.type) && payload.url !== undefined) return payload.url;
  if (MEDIA.has(block.type)) return mediaText(raw, block.type === "image");
  return undefined;
}

/** One block as a line, or lines, of text. `number` is its place in a numbered list. */
function blockText(block: Block, number: number): string {
  const raw = payloadOf(block);
  const parsed = PayloadSchema.safeParse(raw);
  const payload: Payload = parsed.success ? parsed.data : {};
  const text = markdownText(payload.rich_text);
  const prefix = PREFIXES.get(block.type);
  if (prefix !== undefined) return `${prefix}${text}`;
  if (block.type === "numbered_list_item") return `${number}. ${text}`;
  if (block.type === "to_do") return `- [${payload.checked === true ? "x" : " "}] ${text}`;
  if (block.type === "code") return `\`\`\`${payload.language ?? ""}\n${plainCode(payload.rich_text)}\n\`\`\``;
  return structuredText(block, raw, payload) ?? otherText(block, payload);
}

/** A code block's text, which carries no inline markdown. */
function plainCode(value: unknown): string {
  const parsed = z.array(z.object({ plain_text: z.string() }).passthrough()).safeParse(value);
  return parsed.success ? parsed.data.map((run) => run.plain_text).join("") : "";
}

/** A block's nested content: its rows or items when they were read, or where to read them. */
function nestedText(block: Block, children: ChildBlocks): string | undefined {
  if (block.has_children !== true || block.type === "child_page" || block.type === "child_database") return undefined;
  const read = children.get(block.id);
  if (read === undefined) return `  (nested content: read it with get_page_body on block ${block.id})`;
  if (block.type === "table" || read.length === 0) return undefined;
  return renderBlocks(read, children).split("\n").map((line) => `  ${line}`).join("\n");
}

/**
 * Render Notion blocks as markdown-like text, in the same syntax the write tools read.
 *
 * Paragraphs, headings, lists, to-dos, code, quotes, callouts (as `> [!NOTE]` alerts), dividers,
 * images (`![caption](url)`), bookmarks (the bare URL) and tables (as markdown tables) are
 * rendered with their bold, italic, strikethrough, code and links; any other block by its type
 * name in brackets. Children given in `children` are rendered too, list items indented under
 * their parent; a block with children that were not read says so, with the id to read them by.
 *
 * @param blocks - The blocks, in page order.
 * @param children - Children already read, keyed by parent id: a table's rows, a list item's items.
 * @returns One line or more per block.
 *
 * @example
 * renderBlocks(page.results); // "# Plan\n- ship **it**\n1. first"
 */
export function renderBlocks(blocks: readonly Block[], children: ChildBlocks = new Map()): string {
  const lines: string[] = [];
  let number = 0;
  for (const block of blocks) {
    number = block.type === "numbered_list_item" ? number + 1 : 0;
    const rows = block.type === "table" ? children.get(block.id) : undefined;
    lines.push(rows === undefined ? blockText(block, number) : tableText(rows));
    const nested = nestedText(block, children);
    if (nested !== undefined) lines.push(nested);
  }
  return lines.join("\n");
}
