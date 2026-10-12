/** Notion refuses a text run longer than this, so longer text is split into several runs. */
export const RUN_LIMIT = 2_000;

/** Notion refuses a rich-text array with more elements than this. */
export const MAX_RUNS = 100;

/** The inline styles a run can carry, each off unless set. */
export interface InlineStyle {
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly strikethrough?: boolean;
  readonly code?: boolean;
  readonly link?: string;
}

/** The annotations a run sets; Notion treats any it leaves out as off. */
export type Annotations = Partial<Record<"bold" | "italic" | "strikethrough" | "code", boolean>>;

/** One run of rich text as Notion's write endpoints take it. */
export interface RichTextRun {
  readonly type: "text";
  readonly text: { readonly content: string; readonly link?: { readonly url: string } };
  readonly annotations?: Annotations;
}

/** The annotations for a style, or none when the style sets nothing. */
function annotationsOf(style: InlineStyle): Annotations | undefined {
  const annotations: Annotations = {};
  if (style.bold === true) annotations.bold = true;
  if (style.italic === true) annotations.italic = true;
  if (style.strikethrough === true) annotations.strikethrough = true;
  if (style.code === true) annotations.code = true;
  return Object.keys(annotations).length > 0 ? annotations : undefined;
}

/**
 * Text in one style as rich-text runs, each within Notion's 2,000-character limit.
 *
 * @param text - The text.
 * @param style - Its annotations and link; none by default.
 * @returns The runs; none for empty text.
 */
export function styledRuns(text: string, style: InlineStyle = {}): RichTextRun[] {
  const annotations = annotationsOf(style);
  const link = style.link === undefined ? {} : { link: { url: style.link } };
  const out: RichTextRun[] = [];
  for (let start = 0; start < text.length; start += RUN_LIMIT) {
    const content = text.slice(start, start + RUN_LIMIT);
    out.push({ type: "text", text: { content, ...link }, ...(annotations === undefined ? {} : { annotations }) });
  }
  return out;
}

/**
 * Text as plain Notion rich-text runs, with no inline formatting read from it.
 *
 * @param text - The text.
 * @returns The runs; none for empty text.
 *
 * @example
 * richText("x".repeat(4_500)).length; // 3
 */
export function richText(text: string): RichTextRun[] {
  return styledRuns(text);
}
