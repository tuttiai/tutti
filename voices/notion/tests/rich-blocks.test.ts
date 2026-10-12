import { describe, it, expect } from "vitest";

import { readTable, splitRow } from "../src/utils/table-blocks.js";
import { textToBlocks } from "../src/utils/text-to-blocks.js";

/** A table block's rows as the plain text of each cell. */
function cellTexts(table: Record<string, unknown>): string[][] {
  // The shape textToBlocks builds for a table; a wrong guess fails the assertion that reads it.
  const payload = table.table as { children: { table_row: { cells: { text: { content: string } }[][] } }[] };
  return payload.children.map((row) => row.table_row.cells.map((cell) => cell.map((run) => run.text.content).join("")));
}

describe("textToBlocks, rich blocks", () => {
  describe("tables", () => {
    it("turns a markdown table into a table block with a column header", () => {
      const [table] = textToBlocks("| Name | **Role** |\n|:---|---:|\n| Ada | Lead |\n| Bob | `dev` |");
      expect(table).toMatchObject({ type: "table", table: { table_width: 2, has_column_header: true, has_row_header: false } });
      expect(cellTexts(table ?? {})).toEqual([["Name", "Role"], ["Ada", "Lead"], ["Bob", "dev"]]);
      expect(table).toHaveProperty(["table", "children", 0, "table_row", "cells", 1, 0, "annotations"], { bold: true });
    });

    it("pads short rows, cuts long ones and keeps empty cells", () => {
      const [table] = textToBlocks("a | b | c\n--|--|--\n1 |\n1 | | 3 | 4");
      expect(cellTexts(table ?? {})).toEqual([["a", "b", "c"], ["1", "", ""], ["1", "", "3"]]);
    });

    it("reads an escaped pipe as part of the cell", () => {
      expect(splitRow("| a \\| b | c |")).toEqual(["a \\| b", "c"]);
      expect(cellTexts(textToBlocks("| x |\n|---|\n| a \\| b |")[0] ?? {})).toEqual([["x"], ["a | b"]]);
    });

    it("ends the table at the first line without a pipe", () => {
      const out = textToBlocks("| a |\n|---|\n| 1 |\nafter");
      expect(out.map((b) => b.type)).toEqual(["table", "paragraph"]);
    });

    it("takes a header with no body rows", () => {
      expect(cellTexts(textToBlocks("| only |\n| --- |")[0] ?? {})).toEqual([["only"]]);
    });

    it("leaves pipes that are not a table as a paragraph", () => {
      expect(textToBlocks("a | b\nnot a separator").map((b) => b.type)).toEqual(["paragraph", "paragraph"]);
      expect(textToBlocks("| a | b |\n|---|").map((b) => b.type)).toEqual(["paragraph", "paragraph"]);
      expect(readTable(["plain"], 0)).toBeUndefined();
    });

    it("splits a table over Notion's hundred children, repeating the header", () => {
      const body = Array.from({ length: 150 }, (_, i) => `| ${i} |`).join("\n");
      const tables = textToBlocks(`| n |\n|---|\n${body}`);
      expect(tables).toHaveLength(2);
      const [first, second] = tables.map((t) => cellTexts(t));
      expect(first).toHaveLength(100);
      expect(second?.[0]).toEqual(["n"]);
      expect(second?.[1]).toEqual(["99"]);
      expect(second).toHaveLength(52);
    });
  });

  describe("images and bookmarks", () => {
    it("turns a lone markdown image with a public https URL into an external image", () => {
      expect(textToBlocks("![Flow *chart*](https://example.com/flow.png)")[0]).toEqual({
        object: "block",
        type: "image",
        image: {
          type: "external",
          external: { url: "https://example.com/flow.png" },
          caption: [{ type: "text", text: { content: "Flow " } }, { type: "text", text: { content: "chart" }, annotations: { italic: true } }],
        },
      });
      expect(textToBlocks("![](https://example.com/a.png)")[0]).toMatchObject({ image: { caption: [] } });
    });

    it("keeps an image that is not https, or not alone on its line, as a paragraph", () => {
      for (const line of ["![x](http://example.com/a.png)", "![x](ftp://example.com/a.png)", "see ![x](https://example.com/a.png)"]) {
        expect(textToBlocks(line)[0]?.type).toBe("paragraph");
      }
    });

    it("refuses an image on a private or loopback host", () => {
      for (const url of ["https://127.0.0.1/a.png", "https://localhost/a.png", "https://10.0.0.2/a.png", "https://169.254.169.254/a.png"]) {
        const [block] = textToBlocks(`![x](${url})`);
        expect(block?.type).toBe("paragraph");
        expect(JSON.stringify(block)).not.toContain('"external"');
      }
    });

    it("turns a lone public https URL into a bookmark", () => {
      expect(textToBlocks("https://example.com/post")[0]).toEqual({ object: "block", type: "bookmark", bookmark: { url: "https://example.com/post" } });
      expect(textToBlocks("http://example.com/post")[0]?.type).toBe("paragraph");
      expect(textToBlocks("https://192.168.0.1/admin")[0]?.type).toBe("paragraph");
    });
  });

  describe("diagrams and code", () => {
    it("keeps a mermaid fence as a mermaid code block, which Notion draws", () => {
      expect(textToBlocks("```mermaid\ngraph TD\n  A-->B\n```")[0]).toMatchObject({
        type: "code",
        code: { language: "mermaid", rich_text: [{ text: { content: "graph TD\n  A-->B" } }] },
      });
    });

    it("maps short language names and keeps code literal", () => {
      expect(textToBlocks("```ts\nconst a = **b**;\n```")[0]).toEqual({
        object: "block", type: "code", code: { language: "typescript", rich_text: [{ type: "text", text: { content: "const a = **b**;" } }] },
      });
    });
  });

  describe("quotes and callouts", () => {
    it("turns each GitHub alert into a callout with its icon and colour", () => {
      const kinds = [["NOTE", "ℹ️", "blue_background"], ["TIP", "💡", "green_background"], ["IMPORTANT", "❗", "purple_background"],
        ["WARNING", "⚠️", "yellow_background"], ["CAUTION", "🛑", "red_background"]];
      for (const [kind, emoji, color] of kinds) {
        expect(textToBlocks(`> [!${kind}]\n> Mind the **gap**.`)[0]).toMatchObject({
          type: "callout",
          callout: { icon: { type: "emoji", emoji }, color, rich_text: [{ text: { content: "Mind the " } }, { annotations: { bold: true } }, {}] },
        });
      }
    });

    it("takes the callout text from the alert line and the lines after", () => {
      const [block] = textToBlocks("> [!tip] First\n> second\n>\n> third\nafter");
      expect(block).toMatchObject({ type: "callout", callout: { rich_text: [{ text: { content: "First\nsecond\n\nthird" } }] } });
      expect(textToBlocks("> [!NOTE]")[0]).toMatchObject({ type: "callout", callout: { rich_text: [] } });
    });

    it("joins plain quote lines into one quote, and leaves an unknown alert a quote", () => {
      expect(textToBlocks("> one\n> two")).toEqual([
        { object: "block", type: "quote", quote: { rich_text: [{ type: "text", text: { content: "one\ntwo" } }] } },
      ]);
      expect(textToBlocks("> [!SHRUG] hm")[0]).toMatchObject({ type: "quote", quote: { rich_text: [{ text: { content: "[!SHRUG] hm" } }] } });
      expect(textToBlocks(">not a quote")[0]?.type).toBe("paragraph");
    });
  });

  describe("nested lists", () => {
    it("puts items indented by two or four spaces under the item above", () => {
      const out = textToBlocks("- parent\n  - child\n    - deeper\n1. step\n    1) sub\n- [ ] task\n\t- tabbed");
      expect(out.map((b) => b.type)).toEqual(["bulleted_list_item", "numbered_list_item", "to_do"]);
      expect(out[0]).toMatchObject({
        bulleted_list_item: { children: [{ type: "bulleted_list_item" }, { type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ text: { content: "deeper" } }] } }] },
      });
      expect(out[1]).toMatchObject({ numbered_list_item: { children: [{ type: "numbered_list_item" }] } });
      expect(out[2]).toMatchObject({ to_do: { checked: false, children: [{ type: "bulleted_list_item" }] } });
    });

    it("keeps an indented item with no list item above at the top level", () => {
      const out = textToBlocks("Intro\n  - orphan\n# Head\n  - another");
      expect(out.map((b) => b.type)).toEqual(["paragraph", "bulleted_list_item", "heading_1", "bulleted_list_item"]);
      expect(out[1]).not.toHaveProperty("bulleted_list_item.children");
    });

    it("lifts nested items past Notion's hundred children to the top level", () => {
      const out = textToBlocks(["- parent", ...Array.from({ length: 101 }, (_, i) => `  - ${i}`)].join("\n"));
      expect(out).toHaveLength(2);
      expect(out[0]).toHaveProperty("bulleted_list_item.children.length", 100);
      expect(out[1]).toMatchObject({ bulleted_list_item: { rich_text: [{ text: { content: "100" } }] } });
    });

    it("leaves indented text that is not a list item as a paragraph", () => {
      expect(textToBlocks("- item\n  continued")).toEqual([
        expect.objectContaining({ type: "bulleted_list_item" }),
        expect.objectContaining({ type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: "  continued" } }] } }),
      ]);
    });
  });

  it("formats inline markdown in headings, items, to-dos and paragraphs", () => {
    const out = textToBlocks("# A **b**\n- ~~c~~\n- [x] `d`\n[e](https://example.com)");
    expect(out[0]).toMatchObject({ heading_1: { rich_text: [{}, { annotations: { bold: true } }] } });
    expect(out[1]).toMatchObject({ bulleted_list_item: { rich_text: [{ annotations: { strikethrough: true } }] } });
    expect(out[2]).toMatchObject({ to_do: { checked: true, rich_text: [{ annotations: { code: true } }] } });
    expect(out[3]).toMatchObject({ paragraph: { rich_text: [{ text: { content: "e", link: { url: "https://example.com" } } }] } });
  });
});
