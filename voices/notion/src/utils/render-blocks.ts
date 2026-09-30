import { z } from "zod";

import type { Block } from "../notion-schemas.js";
import { plainText } from "./format.js";

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

/** Line prefixes for the block types that are one line of rich text. */
const PREFIXES = new Map<string, string>([
  ["paragraph", ""],
  ["heading_1", "# "],
  ["heading_2", "## "],
  ["heading_3", "### "],
  ["bulleted_list_item", "- "],
  ["quote", "> "],
  ["callout", "> "],
  ["toggle", "- "],
]);

/** A block's payload, which Notion keys by the block's own type. */
function payloadOf(block: Block): Payload {
  const parsed = PayloadSchema.safeParse(new Map(Object.entries(block)).get(block.type));
  return parsed.success ? parsed.data : {};
}

/** A block of a type with no line prefix of its own. */
function otherText(block: Block, payload: Payload): string {
  if (block.type === "divider") return "---";
  if (block.type === "child_page" || block.type === "child_database") {
    return `[${block.type}: ${payload.title ?? "(untitled)"} (${block.id})]`;
  }
  const text = plainText(payload.rich_text);
  const extra = text.length > 0 ? text : (payload.url ?? "");
  return extra.length > 0 ? `[${block.type}] ${extra}` : `[${block.type}]`;
}

/** One block as a line, or lines, of text. `number` is its place in a numbered list. */
function blockText(block: Block, number: number): string {
  const payload = payloadOf(block);
  const text = plainText(payload.rich_text);
  const prefix = PREFIXES.get(block.type);
  if (prefix !== undefined) return `${prefix}${text}`;
  if (block.type === "numbered_list_item") return `${number}. ${text}`;
  if (block.type === "to_do") return `- [${payload.checked === true ? "x" : " "}] ${text}`;
  if (block.type === "code") return `\`\`\`${payload.language ?? ""}\n${text}\n\`\`\``;
  return otherText(block, payload);
}

/**
 * Render Notion blocks as plain, markdown-like text.
 *
 * Paragraphs, headings, bulleted and numbered lists, to-dos, code, quotes and dividers are
 * rendered as their markdown equivalents; any other block by its type name in brackets. Nested
 * content is not fetched: a block that has some says so, with the id to read it by.
 *
 * @param blocks - The blocks, in page order.
 * @returns One line or more per block.
 *
 * @example
 * renderBlocks(page.results); // "# Plan\n- ship it\n1. first"
 */
export function renderBlocks(blocks: readonly Block[]): string {
  const lines: string[] = [];
  let number = 0;
  for (const block of blocks) {
    number = block.type === "numbered_list_item" ? number + 1 : 0;
    lines.push(blockText(block, number));
    if (block.has_children === true && block.type !== "child_page" && block.type !== "child_database") {
      lines.push(`  (nested content: read it with get_page_body on block ${block.id})`);
    }
  }
  return lines.join("\n");
}
