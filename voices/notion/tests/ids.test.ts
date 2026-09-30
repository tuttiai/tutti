import { describe, it, expect } from "vitest";

import { normaliseNotionId } from "../src/index.js";
import { notionIdSchema } from "../src/utils/ids.js";

const HEX = "0123456789ABCDEF0123456789abcdef";
const UUID = "01234567-89ab-cdef-0123-456789abcdef";

describe("normaliseNotionId", () => {
  it.each([
    ["a bare id, in any case", HEX],
    ["a dashed id", "01234567-89AB-cdef-0123-456789abcdef"],
    ["an id with spaces around it", `  ${HEX} `],
    ["a notion.so link with a title slug", `https://www.notion.so/acme/Roadmap-${HEX}`],
    ["a link with a query and a fragment", `https://www.notion.so/${HEX}?v=abc&pvs=4#block`],
    ["a workspace notion.site link", `https://acme.notion.site/Public-Page-${HEX}`],
    ["a link ending in a dashed id", `https://notion.so/Page-${UUID}`],
    ["a link with a trailing slash", `https://www.notion.so/acme/${HEX}/`],
  ])("reads %s", (_label, value) => {
    expect(normaliseNotionId(value)).toBe(UUID);
  });

  it.each([
    ["a short id", "0123456789abcdef"],
    ["an id with a non-hex character", "0123456789abcdef0123456789abcdeg"],
    ["a path traversal", "../../v1/users"],
    ["an id with a path after it", `${HEX}/children`],
    ["another host", `https://evil.example.com/Page-${HEX}`],
    ["a lookalike host", `https://notion.so.evil.example/Page-${HEX}`],
    ["plain http", `http://www.notion.so/Page-${HEX}`],
    ["a link with no id", "https://www.notion.so/acme/Roadmap"],
    ["an empty string", ""],
  ])("refuses %s", (_label, value) => {
    expect(normaliseNotionId(value)).toBeUndefined();
  });
});

describe("notionIdSchema", () => {
  it("parses to the dashed id", () => {
    expect(notionIdSchema("page").parse(HEX)).toBe(UUID);
  });

  it("refuses with a hint naming what the id is for", () => {
    const result = notionIdSchema("database").safeParse("nope");
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/Not a Notion database id.*notion\.so link/);
  });
});
