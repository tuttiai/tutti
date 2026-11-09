import { describe, expect, it } from "vitest";
import { extractSamples, langOf, slugify } from "../../docs/scripts/samples/extract.js";

const FILE = "docs/src/content/docs/guides/x.mdx";
const BT = "```";

function mdx(...lines: string[]): string {
  return lines.join("\n");
}

describe("langOf", () => {
  it("counts ts, tsx and typescript in any case and ignores the meta after the word", () => {
    expect(langOf("ts")).toBe("ts");
    expect(langOf("TypeScript")).toBe("ts");
    expect(langOf("TSX")).toBe("tsx");
    expect(langOf(' ts title="agent.ts" ins={2,12-13}')).toBe("ts");
    expect(langOf("ts{1,3}")).toBe("ts");
    expect(langOf("tsx showLineNumbers")).toBe("tsx");
  });

  it("does not count other languages, a missing word or a longer word starting with ts", () => {
    for (const info of ["js", "jsx", "json", "bash", "", "tsconfig", "ts-node", "mermaid"]) {
      expect(langOf(info)).toBeNull();
    }
  });
});

describe("slugify", () => {
  it("lower-cases and joins runs of other characters with one hyphen, trimmed", () => {
    expect(slugify("Your first agent")).toBe("your-first-agent");
    expect(slugify("`run()` and `stream()`: the API!")).toBe("run-and-stream-the-api");
    expect(slugify("...")).toBe("");
  });
});

describe("extractSamples", () => {
  it("takes backtick and tilde fences with their language, start line and code", () => {
    const text = mdx("# Intro", BT + "ts", "const a = 1;", "const b = 2;", BT, "~~~tsx", "const c = <div />;", "~~~");
    expect(extractSamples(FILE, text)).toEqual([
      { file: FILE, heading: "intro", index: 1, lang: "ts", startLine: 3, indent: 0, code: "const a = 1;\nconst b = 2;" },
      { file: FILE, heading: "intro", index: 2, lang: "tsx", startLine: 7, indent: 0, code: "const c = <div />;" },
    ]);
  });

  it("skips other languages but keeps counting only ts blocks", () => {
    const text = mdx(BT + "bash", "npm i", BT, BT + "json", "{}", BT, BT + "js", "1", BT, BT, "plain", BT, BT + "ts", "1", BT);
    const samples = extractSamples(FILE, text);
    expect(samples.map((s) => [s.heading, s.index, s.startLine])).toEqual([["", 1, 14]]);
  });

  it("numbers blocks per heading, so a new block in one section moves no other key", () => {
    const text = mdx(BT + "ts", "0", BT, "## One", BT + "ts", "1", BT, BT + "ts", "2", BT, "### Two", BT + "ts", "3", BT);
    const keys = extractSamples(FILE, text).map((s) => `${s.heading}#${s.index}`);
    expect(keys).toEqual(["#1", "one#1", "one#2", "two#1"]);
  });

  it("keeps counting under a heading that repeats, so keys stay unique", () => {
    const text = mdx("## Setup", BT + "ts", "1", BT, "## Setup", BT + "ts", "2", BT);
    expect(extractSamples(FILE, text).map((s) => s.index)).toEqual([1, 2]);
  });

  it("ignores headings inside any fenced block and in front matter", () => {
    const text = mdx("---", "# not a heading", "title: X", "---", "## Real", BT + "bash", "# comment", BT, BT + "ts", "1", BT);
    expect(extractSamples(FILE, text)).toMatchObject([{ heading: "real", index: 1, startLine: 10 }]);
  });

  it("closes only on the same character at least as long as the opening fence", () => {
    const text = mdx("````ts", BT, "~~~", "x", "`````", "after");
    expect(extractSamples(FILE, text)).toMatchObject([{ code: "```\n~~~\nx" }]);
  });

  it("does not count a ts block nested inside a longer md fence", () => {
    const text = mdx("````md", BT + "ts", "inner", BT, "````");
    expect(extractSamples(FILE, text)).toEqual([]);
  });

  it("takes indented fences in lists and JSX, removing the fence's indent", () => {
    const tabs = ["<Tabs>", '  <TabItem label="A">', `    ${BT}ts title="a.ts"`, "    const a = 1;", "      nested();", `    ${BT}`];
    const list = ["  </TabItem>", "</Tabs>", "1. Step", `   ${BT}typescript`, "   b();", `   ${BT}`];
    const text = mdx(...tabs, ...list);
    expect(extractSamples(FILE, text)).toMatchObject([
      { index: 1, indent: 4, startLine: 4, code: "const a = 1;\n  nested();" },
      { index: 2, indent: 3, startLine: 11, code: "b();" },
    ]);
  });

  it("runs an unclosed fence to the end of the file", () => {
    expect(extractSamples(FILE, mdx(BT + "ts", "a();", "b();"))).toMatchObject([{ code: "a();\nb();" }]);
  });

  it("treats a backtick line with a backtick in its info string as inline code", () => {
    expect(extractSamples(FILE, mdx("```ts` inline", "## H", BT + "ts", "1", BT))).toMatchObject([{ heading: "h" }]);
  });

  it("handles CRLF line endings and an empty file", () => {
    expect(extractSamples(FILE, `${BT}ts\r\nx\r\n${BT}\r\n`)).toMatchObject([{ code: "x", startLine: 2 }]);
    expect(extractSamples(FILE, "")).toEqual([]);
  });

  it("treats an unterminated front matter block as body text", () => {
    expect(extractSamples(FILE, mdx("---", "# Top", BT + "ts", "1", BT))).toMatchObject([{ heading: "top" }]);
  });
});
