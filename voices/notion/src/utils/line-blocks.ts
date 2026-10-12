import { inlineRichText } from "./inline-markdown.js";
import { safeUrl } from "./url-guard.js";

/** A block as Notion's create and append endpoints take it. */
export type BlockInput = Record<string, unknown>;

/** The block types that can carry a nested list under them. */
export const LIST_ITEM_TYPES: ReadonlySet<string> = new Set(["bulleted_list_item", "numbered_list_item", "to_do"]);

const TODO = /^[-*] \[( |x|X)\] (.*)$/;
const BULLET = /^[-*] (.*)$/;
const NUMBERED = /^\d{1,9}[.)] (.*)$/;
const HEADING = /^(#{1,3}) (.*)$/;
const IMAGE = /^!\[([^\]]*)\]\((\S+)\)$/;
const BARE_URL = /^https:\/\/\S+$/;

/** A list item indented under the one above it: two or more spaces, or a tab, then a marker. */
const NESTED_ITEM = /^(?: {2,}|\t+)(?:[-*] |\d{1,9}[.)] )/;

/**
 * A block whose payload is rich text read for inline formatting, plus any extra payload fields.
 *
 * @param type - The Notion block type, such as `paragraph`.
 * @param text - The block's text, inline markdown included.
 * @param extra - Further payload fields, such as `checked` for a to-do.
 * @returns The block.
 */
export function textBlock(type: string, text: string, extra: Record<string, unknown> = {}): BlockInput {
  return { object: "block", type, [type]: { rich_text: inlineRichText(text), ...extra } };
}

/** `![caption](https://...)` alone on a line, as an external image, if its URL is safe. */
function imageBlock(line: string): BlockInput | undefined {
  const match = IMAGE.exec(line);
  const url = match === null ? undefined : safeUrl(match[2] ?? "", false);
  if (match === null || url === undefined) return undefined;
  return { object: "block", type: "image", image: { type: "external", external: { url }, caption: inlineRichText(match[1] ?? "") } };
}

/** An https URL alone on a line, as a bookmark, if it is safe. */
function bookmarkBlock(line: string): BlockInput | undefined {
  const url = BARE_URL.test(line) ? safeUrl(line, false) : undefined;
  return url === undefined ? undefined : { object: "block", type: "bookmark", bookmark: { url } };
}

/** A heading, list item or to-do, by its marker. */
function markedBlock(line: string): BlockInput | undefined {
  const todo = TODO.exec(line);
  if (todo !== null) return textBlock("to_do", todo[2] ?? "", { checked: todo[1] !== " " });
  const heading = HEADING.exec(line);
  if (heading !== null) return textBlock(`heading_${heading[1]?.length ?? 1}`, heading[2] ?? "");
  const bullet = BULLET.exec(line);
  if (bullet !== null) return textBlock("bulleted_list_item", bullet[1] ?? "");
  const numbered = NUMBERED.exec(line);
  return numbered === null ? undefined : textBlock("numbered_list_item", numbered[1] ?? "");
}

/**
 * Whether a line is a list item indented under the item above it.
 *
 * @param line - The line as written.
 * @returns True for two or more leading spaces, or a tab, before a list marker.
 */
export function isNestedItem(line: string): boolean {
  return NESTED_ITEM.test(line);
}

/**
 * One line of text as one block.
 *
 * @param line - The line, without its trailing whitespace.
 * @returns A heading, list item, to-do, divider, image, bookmark or, failing all of those, a paragraph.
 *
 * @example
 * lineToBlock("![Flow](https://example.com/flow.png)"); // an image block captioned "Flow"
 */
export function lineToBlock(line: string): BlockInput {
  if (line === "---") return { object: "block", type: "divider", divider: {} };
  return markedBlock(line) ?? imageBlock(line) ?? bookmarkBlock(line) ?? textBlock("paragraph", line);
}
