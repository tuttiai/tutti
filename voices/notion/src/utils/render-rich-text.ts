import { z } from "zod";

const RunSchema = z
  .object({
    plain_text: z.string(),
    href: z.string().nullable().optional(),
    annotations: z
      .object({
        bold: z.boolean().optional(),
        italic: z.boolean().optional(),
        strikethrough: z.boolean().optional(),
        code: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const RunListSchema = z.array(RunSchema);

type Run = z.infer<typeof RunSchema>;

/** Text wrapped in a marker on both sides. */
function wrap(text: string, marker: string, on: boolean | undefined): string {
  return on === true ? `${marker}${text}${marker}` : text;
}

/**
 * One run as inline markdown. Leading and trailing spaces are kept outside the markers, where
 * markdown needs them to be. Italic is written with underscores so that bold italic reads back
 * as `**_both_**` rather than an ambiguous `***both***`.
 */
function runMarkdown(run: Run): string {
  const text = run.plain_text;
  const inner = text.trim();
  if (inner.length === 0) return text;
  const lead = text.slice(0, text.indexOf(inner));
  const trail = text.slice(lead.length + inner.length);
  const style = run.annotations ?? {};
  let out = wrap(inner, "`", style.code);
  out = wrap(wrap(wrap(out, "~~", style.strikethrough), "_", style.italic), "**", style.bold);
  if (typeof run.href === "string" && run.href.length > 0) out = `[${out}](${run.href})`;
  return `${lead}${out}${trail}`;
}

/**
 * A rich-text array as inline markdown: bold, italic, strikethrough, code and links written the
 * way the write tools read them back, so text read from one page can be written to another
 * without losing its formatting.
 *
 * @param value - A Notion rich-text array, unvalidated.
 * @returns Its runs as markdown, or an empty string for anything that is not rich text.
 *
 * @example
 * markdownText([{ plain_text: "ship", annotations: { bold: true } }]); // "**ship**"
 */
export function markdownText(value: unknown): string {
  const parsed = RunListSchema.safeParse(value);
  return parsed.success ? parsed.data.map(runMarkdown).join("") : "";
}
