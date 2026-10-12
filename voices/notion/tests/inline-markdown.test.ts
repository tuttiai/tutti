import { describe, it, expect } from "vitest";

import { inlineRichText } from "../src/utils/inline-markdown.js";
import { safeUrl } from "../src/utils/url-guard.js";

/** Each run as [content, annotations, link], for compact assertions. */
function runs(text: string): [string, Record<string, boolean> | undefined, string | undefined][] {
  return inlineRichText(text).map((run) => [run.text.content, run.annotations, run.text.link?.url]);
}

describe("inlineRichText", () => {
  it("leaves plain text as one plain run", () => {
    expect(inlineRichText("just words")).toEqual([{ type: "text", text: { content: "just words" } }]);
    expect(inlineRichText("")).toEqual([]);
  });

  it("reads bold, italic, strikethrough and code", () => {
    expect(runs("a **b** *c* _d_ ~~e~~ `f`")).toEqual([
      ["a ", undefined, undefined],
      ["b", { bold: true }, undefined],
      [" ", undefined, undefined],
      ["c", { italic: true }, undefined],
      [" ", undefined, undefined],
      ["d", { italic: true }, undefined],
      [" ", undefined, undefined],
      ["e", { strikethrough: true }, undefined],
      [" ", undefined, undefined],
      ["f", { code: true }, undefined],
    ]);
  });

  it("nests styles the way markdown does", () => {
    expect(runs("**bold _both_**")).toEqual([
      ["bold ", { bold: true }, undefined],
      ["both", { bold: true, italic: true }, undefined],
    ]);
    expect(runs("*a **b** c*")).toEqual([
      ["a ", { italic: true }, undefined],
      ["b", { bold: true, italic: true }, undefined],
      [" c", { italic: true }, undefined],
    ]);
  });

  it("takes code literally", () => {
    expect(runs("`**not bold**`")).toEqual([["**not bold**", { code: true }, undefined]]);
  });

  it("reads links, with formatting inside the label", () => {
    expect(runs("see [the **docs**](https://example.com/a?b=1) now")).toEqual([
      ["see ", undefined, undefined],
      ["the ", undefined, "https://example.com/a?b=1"],
      ["docs", { bold: true }, "https://example.com/a?b=1"],
      [" now", undefined, undefined],
    ]);
    expect(runs("[plain](http://example.com)")).toEqual([["plain", undefined, "http://example.com"]]);
  });

  it("keeps unclosed and empty markers literal", () => {
    for (const text of ["**open", "*open", "~~open", "`open", "[open](https://x.com", "[open]", "a ** b", "****", "``", "[](https://x.com)"]) {
      expect(runs(text)).toEqual([[text, undefined, undefined]]);
    }
  });

  it("needs emphasis to hug its text", () => {
    expect(runs("2 * 3 * 4")).toEqual([["2 * 3 * 4", undefined, undefined]]);
    expect(runs("** spaced **")).toEqual([["** spaced **", undefined, undefined]]);
  });

  it("leaves underscores inside words alone", () => {
    expect(runs("snake_case_name and _real_")).toEqual([
      ["snake_case_name and ", undefined, undefined],
      ["real", { italic: true }, undefined],
    ]);
    expect(runs("_a_b")).toEqual([["_a_b", undefined, undefined]]);
  });

  it("makes an escaped marker literal and leaves other backslashes", () => {
    expect(runs("\\*not\\* C:\\path")).toEqual([["*not* C:\\path", undefined, undefined]]);
  });

  it("splits a long styled run at Notion's limit", () => {
    const out = inlineRichText(`**${"x".repeat(4_100)}**`);
    expect(out.map((run) => run.text.content.length)).toEqual([2_000, 2_000, 100]);
    expect(out.every((run) => run.annotations?.bold === true)).toBe(true);
  });

  it("sends text needing more than a hundred runs unformatted", () => {
    const text = Array.from({ length: 60 }, (_, i) => `**${i}**`).join(" ");
    expect(inlineRichText(text)).toEqual([{ type: "text", text: { content: text } }]);
  });

  describe("security", () => {
    it("keeps links to private, loopback and non-web addresses as text", () => {
      for (const url of [
        "http://localhost:8080/admin", "http://127.0.0.1/", "http://10.0.0.5/", "http://192.168.1.1/",
        "http://172.16.0.1/", "http://169.254.169.254/latest/meta-data", "javascript:alert(1)", "file:///etc/passwd",
        "http://[::1]/", "http://user:pw@example.com/",
      ]) {
        const text = `[x](${url})`;
        expect(runs(text)).toEqual([[text, undefined, undefined]]);
      }
    });
  });
});

describe("safeUrl", () => {
  it("accepts public https, and http only when asked", () => {
    expect(safeUrl("https://example.com/a.png", false)).toBe("https://example.com/a.png");
    expect(safeUrl("http://example.com/a.png", false)).toBeUndefined();
    expect(safeUrl("http://example.com/a.png", true)).toBe("http://example.com/a.png");
  });

  it("refuses loopback, private, link-local, CGNAT and IPv6 private hosts", () => {
    for (const host of [
      "localhost", "app.localhost", "127.1.2.3", "0.0.0.0", "10.1.1.1", "172.31.0.1", "192.168.0.1", "169.254.169.254",
      "100.64.0.1", "[::1]", "[fd00::1]", "[fe80::1]", "[::ffff:127.0.0.1]", "2130706433", "localhost.",
    ]) {
      expect(safeUrl(`https://${host}/x`, false)).toBeUndefined();
    }
  });

  it("accepts addresses next to the private ranges", () => {
    expect(safeUrl("https://172.32.0.1/x", false)).toBeDefined();
    expect(safeUrl("https://100.128.0.1/x", false)).toBeDefined();
  });

  it("refuses unparseable, credentialed and overlong URLs", () => {
    expect(safeUrl("not a url", true)).toBeUndefined();
    expect(safeUrl("https://u:p@example.com/", false)).toBeUndefined();
    expect(safeUrl(`https://example.com/${"a".repeat(2_000)}`, false)).toBeUndefined();
  });
});
