import { z } from "zod";

import type { Block } from "../notion-schemas.js";
import { CALLOUTS } from "./quote-blocks.js";
import { markdownText } from "./render-rich-text.js";

const RowSchema = z.object({ cells: z.array(z.unknown()) }).passthrough();
const IconSchema = z.object({ emoji: z.string() }).passthrough();
const FileSchema = z
  .object({ external: z.object({ url: z.string() }).optional(), file: z.object({ url: z.string() }).optional() })
  .passthrough();

/** The alert kind each callout icon stands for; any other icon reads as a note. */
const KINDS = new Map([...CALLOUTS].map(([kind, style]) => [style.emoji, kind]));

/**
 * A block's payload, which Notion keys by the block's own type.
 *
 * @param block - The block.
 * @returns The payload, unvalidated.
 */
export function payloadOf(block: Block): unknown {
  return new Map(Object.entries(block)).get(block.type);
}

/** One table cell as markdown: a pipe escaped, a line break flattened to a space. */
function cellText(cell: unknown): string {
  return markdownText(cell).replaceAll("|", "\\|").replaceAll("\n", " ");
}

/** One table row's cells, padded to the table's width. */
function rowCells(row: Block, width: number): string[] {
  const parsed = RowSchema.safeParse(payloadOf(row));
  const cells = parsed.success ? parsed.data.cells.map(cellText) : [];
  while (cells.length < width) cells.push("");
  return cells;
}

/**
 * A table and its rows as a markdown table. Markdown needs a header, so the first row is
 * written as one whether or not Notion marks it so.
 *
 * @param rows - The table's `table_row` children, in order.
 * @returns The table, one line per row with a separator under the first.
 */
export function tableText(rows: readonly Block[]): string {
  const width = Math.max(1, ...rows.map((row) => RowSchema.safeParse(payloadOf(row)).data?.cells.length ?? 0));
  const lines = rows.map((row) => `| ${rowCells(row, width).join(" | ")} |`);
  lines.splice(1, 0, `|${" --- |".repeat(width)}`);
  return lines.join("\n");
}

/**
 * Text as a quote: every line opened with `> `.
 *
 * @param text - The quote's text.
 * @returns The quoted lines.
 */
export function quoteText(text: string): string {
  return text.split("\n").map((line) => (line.length > 0 ? `> ${line}` : ">")).join("\n");
}

/**
 * A callout as a GitHub alert, its kind read back from the icon it was written with.
 *
 * @param payload - The callout block's payload, unvalidated.
 * @returns `> [!KIND]` and the quoted text.
 */
export function calloutText(payload: unknown): string {
  const icon = z.object({ icon: IconSchema }).passthrough().safeParse(payload);
  const kind = (icon.success ? KINDS.get(icon.data.icon.emoji) : undefined) ?? "NOTE";
  const text = markdownText(z.object({ rich_text: z.unknown() }).passthrough().safeParse(payload).data?.rich_text);
  return text.length > 0 ? `> [!${kind}]\n${quoteText(text)}` : `> [!${kind}]`;
}

/**
 * An image as `![caption](url)`, or a file, video or PDF as `[caption](url)`; `undefined` when
 * it has no URL.
 *
 * @param payload - The block's payload, unvalidated.
 * @param image - Whether the block is an image.
 * @returns The markdown image or link.
 */
export function mediaText(payload: unknown, image: boolean): string | undefined {
  const parsed = FileSchema.safeParse(payload);
  const url = parsed.data?.external?.url ?? parsed.data?.file?.url;
  if (url === undefined) return undefined;
  const caption = markdownText(z.object({ caption: z.unknown() }).passthrough().safeParse(payload).data?.caption);
  if (image) return `![${caption}](${url})`;
  return `[${caption.length > 0 ? caption : "file"}](${url})`;
}
