import { describe, it, expect } from "vitest";

import { BlockSchema, type Block } from "../src/notion-schemas.js";
import { databaseTitle, pageTitle, propertyText } from "../src/utils/format.js";
import { renderBlocks } from "../src/utils/render-blocks.js";
import { richText, textToBlocks } from "../src/utils/text-to-blocks.js";
import { block, rich } from "./fake-notion.js";

function blocks(...raw: Record<string, unknown>[]): Block[] {
  return raw.map((item) => BlockSchema.parse(item));
}

describe("renderBlocks", () => {
  it("renders every block type it knows as markdown", () => {
    const text = renderBlocks(blocks(
      block("heading_1", { rich_text: rich("One") }),
      block("heading_2", { rich_text: rich("Two") }),
      block("heading_3", { rich_text: rich("Three") }),
      block("paragraph", { rich_text: rich("Para") }),
      block("bulleted_list_item", { rich_text: rich("bullet") }),
      block("numbered_list_item", { rich_text: rich("first") }),
      block("numbered_list_item", { rich_text: rich("second") }),
      block("to_do", { rich_text: rich("done"), checked: true }),
      block("to_do", { rich_text: rich("open"), checked: false }),
      block("numbered_list_item", { rich_text: rich("again") }),
      block("code", { rich_text: rich("let x = 1;"), language: "typescript" }),
      block("quote", { rich_text: rich("said") }),
      block("divider", {}),
    ));
    expect(text).toBe([
      "# One", "## Two", "### Three", "Para", "- bullet", "1. first", "2. second",
      "- [x] done", "- [ ] open", "1. again", "```typescript\nlet x = 1;\n```", "> said", "---",
    ].join("\n"));
  });

  it("names other blocks by type, with their text or link", () => {
    const text = renderBlocks(blocks(
      block("child_page", { title: "Sub" }, { id: "p1", has_children: true }),
      block("child_database", {}, { id: "d1" }),
      block("bookmark", { url: "https://example.com" }),
      block("image", { type: "file" }),
      block("callout", { rich_text: rich("Note") }),
      { object: "block", id: "odd", type: "table" },
    ));
    expect(text).toBe("[child_page: Sub (p1)]\n[child_database: (untitled) (d1)]\n[bookmark] https://example.com\n[image]\n> Note\n[table]");
  });

  it("points at nested content by id", () => {
    const text = renderBlocks(blocks(block("toggle", { rich_text: rich("More") }, { id: "t1", has_children: true })));
    expect(text).toBe("- More\n  (nested content: read it with get_page_body on block t1)");
  });
});

describe("textToBlocks", () => {
  it("converts each line to its block and skips blank ones", () => {
    const out = textToBlocks("# H1\r\n## H2\n### H3\n\n- a\n* b\n1. c\n2) d\n- [ ] e\n- [x] f\n> g\n---\nplain  ");
    expect(out.map((b) => b.type)).toEqual([
      "heading_1", "heading_2", "heading_3", "bulleted_list_item", "bulleted_list_item", "numbered_list_item",
      "numbered_list_item", "to_do", "to_do", "quote", "divider", "paragraph",
    ]);
    expect(out[7]).toMatchObject({ to_do: { checked: false, rich_text: [{ text: { content: "e" } }] } });
    expect(out[8]).toMatchObject({ to_do: { checked: true } });
    expect(out[11]).toMatchObject({ paragraph: { rich_text: [{ text: { content: "plain" } }] } });
  });

  it("keeps a fenced block whole, with a language Notion accepts", () => {
    expect(textToBlocks("```python\nx = 1\n\ny = 2\n```")).toEqual([
      { object: "block", type: "code", code: { rich_text: richText("x = 1\n\ny = 2"), language: "python" } },
    ]);
    expect(textToBlocks("```klingon\nqapla\n```")[0]).toMatchObject({ code: { language: "plain text" } });
  });

  it("closes a fence left open at the end", () => {
    expect(textToBlocks("```\nunterminated")[0]).toMatchObject({ type: "code", code: { language: "plain text" } });
  });

  it("splits text longer than Notion's run limit", () => {
    expect(richText("x".repeat(4_500)).map((run) => run.text.content.length)).toEqual([2_000, 2_000, 500]);
    expect(richText("")).toEqual([]);
  });
});

describe("format", () => {
  it("reads unset and unknown property values without failing", () => {
    expect(propertyText({ type: "select", select: null })).toBe("");
    expect(propertyText({ type: "date", date: null })).toBe("");
    expect(propertyText({ type: "unique_id", unique_id: { prefix: null, number: 4 } })).toBe("4");
    expect(propertyText({ type: "unique_id", unique_id: { number: null } })).toBe("");
    expect(propertyText({ type: "rollup", rollup: "odd" })).toBe("");
    expect(propertyText({ type: "url", url: null })).toBe("");
    expect(propertyText({ type: "files", files: [{ name: "a.pdf" }] })).toBe("a.pdf");
    expect(propertyText({ type: "date", date: { start: "2026-01-01" } })).toBe("2026-01-01");
    expect(propertyText({ type: "verification", verification: [1] })).toBe("");
  });

  it("calls a page or database with no title untitled", () => {
    expect(pageTitle({ object: "page", id: "p", properties: {} })).toBe("(untitled)");
    expect(databaseTitle({ object: "database", id: "d", properties: {} })).toBe("(untitled)");
  });
});
