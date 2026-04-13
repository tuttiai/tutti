import { extname } from "node:path";
import { parseMarkdown } from "./markdown.js";
import { parsePdf } from "./pdf.js";
import { parseText } from "./text.js";

/** Discriminator used to route parsing. */
export type ParserFormat = "pdf" | "markdown" | "text";

/**
 * Infer a {@link ParserFormat} from a MIME type, file extension, or URL
 * pathname. Unknown inputs fall back to `"text"`.
 */
export function detectFormat(input: {
  mime_type?: string;
  filename?: string;
}): ParserFormat {
  const mime = input.mime_type?.toLowerCase() ?? "";
  const ext = input.filename ? extname(input.filename).toLowerCase() : "";

  // Specific MIME types win — these are unambiguous.
  if (mime.includes("pdf")) return "pdf";
  if (mime.includes("markdown")) return "markdown";

  // Extensions beat generic `text/plain`: GitHub raw, S3, and plenty of
  // static hosts serve `README.md` as `text/plain`, so the filename is the
  // more reliable signal.
  if (ext === ".pdf") return "pdf";
  if (ext === ".md" || ext === ".markdown" || ext === ".mdx") return "markdown";

  return "text";
}

/** Parse `buffer` into plain text according to `format`. */
export async function parseBuffer(
  buffer: Buffer,
  format: ParserFormat,
): Promise<string> {
  switch (format) {
    case "pdf":
      return parsePdf(buffer);
    case "markdown":
      return parseMarkdown(buffer);
    case "text":
      return parseText(buffer);
  }
}
