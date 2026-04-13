import { remark } from "remark";
import stripMarkdown from "strip-markdown";

// YAML/TOML frontmatter fenced by --- or +++ at the very start of a file.
const FRONTMATTER_RE = /^(---|\+\+\+)\r?\n[\s\S]*?\r?\n\1\r?\n?/;

/**
 * Strip YAML/TOML frontmatter and convert Markdown to plain text.
 *
 * Uses the `remark` + `strip-markdown` pipeline so formatting syntax is
 * removed cleanly (including links, code fences, images, tables).
 */
export async function parseMarkdown(buffer: Buffer): Promise<string> {
  const raw = buffer.toString("utf-8").replace(/\r\n/g, "\n");
  const withoutFrontmatter = raw.replace(FRONTMATTER_RE, "");
  const file = await remark().use(stripMarkdown).process(withoutFrontmatter);
  return String(file).trim();
}
