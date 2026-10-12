import { textBlock, type BlockInput } from "./line-blocks.js";

/** What reading a quote gave: one block, and the line after the quote. */
export interface QuoteRead {
  readonly block: BlockInput;
  readonly next: number;
}

/** The GitHub alert kinds, each with the icon and colour its callout takes. */
export const CALLOUTS: ReadonlyMap<string, { readonly emoji: string; readonly color: string }> = new Map([
  ["NOTE", { emoji: "ℹ️", color: "blue_background" }],
  ["TIP", { emoji: "💡", color: "green_background" }],
  ["IMPORTANT", { emoji: "❗", color: "purple_background" }],
  ["WARNING", { emoji: "⚠️", color: "yellow_background" }],
  ["CAUTION", { emoji: "🛑", color: "red_background" }],
]);

const QUOTE_LINE = /^>(?: |$)/;
const ALERT = /^\[!([A-Za-z]+)\]\s*(.*)$/;

/** A quote line's text: the line without its `> ` or `>`. */
function unquoted(line: string): string {
  return line.startsWith("> ") ? line.slice(2) : line.slice(1);
}

/** The callout for an alert's kind and text, or `undefined` for a kind GitHub does not define. */
function callout(kind: string, text: string): BlockInput | undefined {
  const style = CALLOUTS.get(kind.toUpperCase());
  if (style === undefined) return undefined;
  return textBlock("callout", text, { icon: { type: "emoji", emoji: style.emoji }, color: style.color });
}

/**
 * Read the quote starting at `start`, if one does: every following line that opens with `> `,
 * or is a bare `>`, joined into one block.
 *
 * A quote whose first line is a GitHub alert, `> [!NOTE]`, `[!TIP]`, `[!IMPORTANT]`,
 * `[!WARNING]` or `[!CAUTION]`, becomes a callout with a matching icon and colour, its text taken
 * from the rest of that line and the lines after. Any other quote becomes a quote block.
 *
 * @param lines - Every line of the text.
 * @param start - The line that may open a quote.
 * @returns The block and the line after the quote, or `undefined` when no quote starts here.
 *
 * @example
 * readQuote(["> [!TIP]", "> Run it twice."], 0); // a callout with a 💡 icon, next: 2
 */
export function readQuote(lines: readonly string[], start: number): QuoteRead | undefined {
  const body: string[] = [];
  let next = start;
  for (let line = lines.at(next); line !== undefined && QUOTE_LINE.test(line); line = lines.at(next)) {
    body.push(unquoted(line));
    next += 1;
  }
  if (body.length === 0) return undefined;
  const alert = ALERT.exec(body[0] ?? "");
  if (alert !== null) {
    const text = [alert[2] ?? "", ...body.slice(1)].filter((part, index) => index > 0 || part.length > 0).join("\n");
    const block = callout(alert[1] ?? "", text);
    if (block !== undefined) return { block, next };
  }
  return { block: textBlock("quote", body.join("\n")), next };
}
