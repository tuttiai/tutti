import { describe, it, expect } from "vitest";
import { linesOf, MAX_PAGE_CHARS, pageHeader, pageOf } from "../src/utils/file-pages.js";

const ten = Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join("\n") + "\n";

describe("linesOf", () => {
  it("does not count the empty string after a final newline as a line", () => {
    expect(linesOf("a\nb\n")).toEqual(["a", "b"]);
    expect(linesOf("a\nb")).toEqual(["a", "b"]);
    expect(linesOf("")).toEqual([]);
  });
});

describe("pageOf", () => {
  it("returns the whole file as complete when it fits", () => {
    const page = pageOf(ten, { offset: 1 });
    expect(page).toMatchObject({ first: 1, last: 10, totalLines: 10, partial: false });
    expect(page.text.split("\n")).toHaveLength(10);
  });

  it("takes limit lines from offset and marks the page partial", () => {
    const page = pageOf(ten, { offset: 4, limit: 3 });
    expect(page).toMatchObject({ text: "l4\nl5\nl6", first: 4, last: 6, partial: true });
  });

  it("marks a page that ends at the last line but starts later as partial", () => {
    expect(pageOf(ten, { offset: 9 })).toMatchObject({ first: 9, last: 10, partial: true });
  });

  it("stops on a whole line at the character cap", () => {
    const line = "x".repeat(1000);
    const text = Array.from({ length: 100 }, () => line).join("\n");
    const page = pageOf(text, { offset: 1 });
    expect(page.text.length).toBeLessThanOrEqual(MAX_PAGE_CHARS);
    expect(page.last).toBe(39);
    expect(page.partial).toBe(true);
  });

  it("cuts a single line longer than the cap and still calls it partial", () => {
    const page = pageOf("y".repeat(MAX_PAGE_CHARS + 10), { offset: 1 });
    expect(page.text).toHaveLength(MAX_PAGE_CHARS);
    expect(page).toMatchObject({ first: 1, last: 1, totalLines: 1, partial: true });
  });

  it("returns nothing from an offset past the end", () => {
    expect(pageOf(ten, { offset: 50 })).toMatchObject({ text: "", first: 0, last: 0, partial: true });
  });
});

describe("pageHeader", () => {
  it("says complete for a whole file", () => {
    expect(pageHeader("a @ main", pageOf(ten, { offset: 1 }), 41)).toBe("[a @ main: lines 1-10 of 10 (41 bytes), complete]");
  });

  it("names the next offset and warns against writing a partial page back", () => {
    const header = pageHeader("a @ main", pageOf(ten, { offset: 1, limit: 4 }), 41);
    expect(header).toContain("PARTIAL: next offset=5");
    expect(header).toContain("use edit_file");
  });

  it("says when the last line itself was cut", () => {
    const page = pageOf("z".repeat(MAX_PAGE_CHARS + 1), { offset: 1 });
    expect(pageHeader("a", page, MAX_PAGE_CHARS + 1)).toContain("the last line was cut at the character cap");
  });

  it("describes an empty file and an offset past the end", () => {
    expect(pageHeader("e", pageOf("", { offset: 1 }), 0)).toBe("[e: empty file, 0 bytes]");
    expect(pageHeader("a", pageOf(ten, { offset: 50 }), 41)).toBe("[a: no lines from that offset; the file has 10 lines, 41 bytes]");
  });
});
