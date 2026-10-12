import { describe, it, expect } from "vitest";

import { BlockSchema, type Block } from "../src/notion-schemas.js";
import { renderBlocks } from "../src/utils/render-blocks.js";
import { markdownText } from "../src/utils/render-rich-text.js";
import { tableText } from "../src/utils/render-special.js";
import { textToBlocks } from "../src/utils/text-to-blocks.js";
import { block, rich } from "./fake-notion.js";

/** A run as Notion answers it, with annotations and an optional link. */
function run(text: string, annotations: Record<string, boolean> = {}, href: string | null = null): Record<string, unknown> {
  return { type: "text", plain_text: text, href, annotations: { bold: false, italic: false, strikethrough: false, code: false, ...annotations } };
}

function parsed(raw: Record<string, unknown>): Block {
  return BlockSchema.parse(raw);
}

function row(...cells: string[]): Block {
  return parsed(block("table_row", { cells: cells.map((cell) => rich(cell)) }, { id: `row-${cells.join("-")}` }));
}

/** A write-side run object rewritten as Notion answers it: `plain_text` and `href` in place of `text`. */
const WRITTEN_RUN = /"text":\{"content":("(?:[^"\\]|\\.)*")(?:,"link":\{"url":("(?:[^"\\]|\\.)*")\})?\}/g;

/**
 * What Notion would answer for blocks written by textToBlocks: each block given an id, its runs
 * in the read shape, and its nested children (a table's rows, a list item's items) moved into
 * the map, as get_page_body reads them.
 */
function asRead(written: readonly Record<string, unknown>[], children: Map<string, Block[]>, prefix = "b"): Block[] {
  return written.map((item, index) => {
    const id = `${prefix}${index}`;
    const json = JSON.stringify(item).replace(WRITTEN_RUN, (_m, content: string, url?: string) => `"plain_text":${content},"href":${url ?? "null"}`);
    // Parsed back from the JSON of a block textToBlocks built, so it is an object keyed by its type.
    const raw = JSON.parse(json) as Record<string, Record<string, unknown>>;
    const payload = raw[String(raw.type)] ?? {};
    // textToBlocks puts nested blocks, when there are any, in an array under `children`.
    const nested = payload.children as Record<string, unknown>[] | undefined;
    if (nested !== undefined) children.set(id, asRead(nested, children, `${id}.`));
    delete payload.children;
    return parsed({ ...raw, id, has_children: nested !== undefined });
  });
}

describe("markdownText", () => {
  it("writes each annotation and link the way the write tools read them", () => {
    expect(markdownText([
      run("plain "), run("bold", { bold: true }), run(" "), run("it", { italic: true }), run(" "),
      run("gone", { strikethrough: true }), run(" "), run("x()", { code: true }), run(" "), run("both", { bold: true, italic: true }),
      run(" "), run("docs", {}, "https://example.com"),
    ])).toBe("plain **bold** _it_ ~~gone~~ `x()` **_both_** [docs](https://example.com)");
  });

  it("keeps spaces outside the markers", () => {
    expect(markdownText([run(" padded ", { bold: true }), run("   ", { bold: true })])).toBe(" **padded**    ");
  });

  it("reads anything that is not rich text as empty", () => {
    expect(markdownText("nope")).toBe("");
    expect(markdownText([{ plain_text: "bare" }])).toBe("bare");
  });
});

describe("renderBlocks, rich blocks", () => {
  it("renders a table from its rows, escaping pipes and padding short rows", () => {
    const table = parsed(block("table", { table_width: 2, has_column_header: true }, { id: "t1", has_children: true }));
    const rows = [row("Name", "Role"), row("Ada", "a|b"), parsed(block("table_row", { cells: [rich("Solo")] }))];
    expect(renderBlocks([table], new Map([["t1", rows]]))).toBe("| Name | Role |\n| --- | --- |\n| Ada | a\\|b |\n| Solo |  |");
  });

  it("points at a table whose rows were not read", () => {
    const table = parsed(block("table", { table_width: 1 }, { id: "t2", has_children: true }));
    expect(renderBlocks([table])).toBe("[table]\n  (nested content: read it with get_page_body on block t2)");
  });

  it("renders a table row block that is not a row as an empty cell", () => {
    expect(tableText([parsed(block("table_row", { cells: "odd" }))])).toBe("|  |\n| --- |");
  });

  it("renders callouts as alerts, reading the kind from the icon", () => {
    const out = renderBlocks([
      parsed(block("callout", { rich_text: rich("Two\nlines"), icon: { type: "emoji", emoji: "⚠️" } })),
      parsed(block("callout", { rich_text: rich("Odd icon"), icon: { type: "emoji", emoji: "🦄" } })),
      parsed(block("callout", { rich_text: [], icon: { type: "emoji", emoji: "💡" } })),
    ]);
    expect(out).toBe("> [!WARNING]\n> Two\n> lines\n> [!NOTE]\n> Odd icon\n> [!TIP]");
  });

  it("renders images, files and bookmarks as links", () => {
    const out = renderBlocks([
      parsed(block("image", { type: "external", external: { url: "https://e.com/a.png" }, caption: rich("Flow") })),
      parsed(block("image", { type: "file", file: { url: "https://s3.example/a.png" }, caption: [] })),
      parsed(block("pdf", { type: "file", file: { url: "https://s3.example/a.pdf" }, caption: [] })),
      parsed(block("video", { type: "external", external: { url: "https://e.com/v" }, caption: rich("Demo") })),
      parsed(block("bookmark", { url: "https://e.com/post" })),
      parsed(block("embed", { url: "https://e.com/embed" })),
    ]);
    expect(out).toBe("![Flow](https://e.com/a.png)\n![](https://s3.example/a.png)\n[file](https://s3.example/a.pdf)\n[Demo](https://e.com/v)\nhttps://e.com/post\nhttps://e.com/embed");
  });

  it("renders a multi-line quote line by line, and code without inline markdown", () => {
    const out = renderBlocks([
      parsed(block("quote", { rich_text: rich("one\n\ntwo") })),
      parsed(block("code", { rich_text: [run("a **b**", { bold: true })], language: "mermaid" })),
    ]);
    expect(out).toBe("> one\n>\n> two\n```mermaid\na **b**\n```");
  });

  it("indents list children that were read, and numbers them on their own", () => {
    const parent = parsed(block("numbered_list_item", { rich_text: rich("step") }, { id: "n1", has_children: true }));
    const kids = [
      parsed(block("numbered_list_item", { rich_text: rich("sub") })),
      parsed(block("bulleted_list_item", { rich_text: rich("deep") }, { id: "b9", has_children: true })),
    ];
    expect(renderBlocks([parent], new Map([["n1", kids]]))).toBe(
      "1. step\n  1. sub\n  - deep\n    (nested content: read it with get_page_body on block b9)",
    );
  });

  it("reads back what textToBlocks wrote", () => {
    const text = [
      "# Report **Q3**",
      "Intro with _emphasis_, ~~old~~, `code` and [a link](https://example.com/x).",
      "- parent",
      "  - child",
      "1. first",
      "- [x] done",
      "| Metric | Value |",
      "| --- | --- |",
      "| **Users** | 1,200 |",
      "| Churn |  |",
      "> [!WARNING]",
      "> Watch **this**.",
      "",
      "> plain quote",
      "![Chart](https://example.com/chart.png)",
      "https://example.com/post",
      "```mermaid",
      "graph TD",
      "```",
      "---",
    ];
    const children = new Map<string, Block[]>();
    const read = asRead(textToBlocks(text.join("\n")), children);
    expect(renderBlocks(read, children)).toBe(text.filter((line) => line.length > 0).join("\n"));
  });
});
