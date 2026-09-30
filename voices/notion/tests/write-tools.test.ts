import { describe, it, expect, vi } from "vitest";

import { NOTION_API_BASE, type NotionFetch } from "../src/index.js";
import { DB_ID, DB_UUID, PAGE_ID, PAGE_UUID, callOf, fakeFetch, json, list, page, run, voiceWith } from "./fake-notion.js";

const DATABASE = {
  object: "database",
  id: DB_UUID,
  properties: { Task: { id: "title", type: "title", title: {} }, Status: { id: "s", type: "status", status: {} } },
};

describe("write tools", () => {
  describe("create_page", () => {
    it("creates a page under a page with its title and converted body", async () => {
      const fetchImpl = fakeFetch(json(200, page("Notes")));
      const result = await run(voiceWith(fetchImpl), "create_page", {
        parent_type: "page", parent_id: PAGE_ID, title: "Notes", content: "# Hi\n- one",
      });
      const { url, init, body } = callOf(fetchImpl);
      expect(url).toBe(`${NOTION_API_BASE}/pages`);
      expect(init.method).toBe("POST");
      expect(body).toMatchObject({
        parent: { page_id: PAGE_UUID },
        properties: { title: { title: [{ type: "text", text: { content: "Notes" } }] } },
        children: [{ type: "heading_1" }, { type: "bulleted_list_item" }],
      });
      expect(result.content).toMatch(/^Created page "Notes" \(01234567-.*\): https:\/\/www\.notion\.so\//);
    });

    it("sends no children when there is no content", async () => {
      const fetchImpl = fakeFetch(json(200, page("Bare", { url: undefined })));
      const result = await run(voiceWith(fetchImpl), "create_page", { parent_type: "page", parent_id: PAGE_ID, title: "Bare" });
      expect(callOf(fetchImpl).body).not.toHaveProperty("children");
      expect(result.content).toBe(`Created page "Bare" (${PAGE_UUID})`);
    });

    it("finds a database's title property and sets it beside the given properties", async () => {
      const fetchImpl = fakeFetch(json(200, DATABASE), json(200, page("Ship")));
      const status = { status: { name: "Todo" } };
      await run(voiceWith(fetchImpl), "create_page", { parent_type: "database", parent_id: DB_ID, title: "Ship", properties: { Status: status } });
      expect(callOf(fetchImpl, 0).url).toBe(`${NOTION_API_BASE}/databases/${DB_UUID}`);
      expect(callOf(fetchImpl, 1).body).toMatchObject({
        parent: { database_id: DB_UUID },
        properties: { Status: status, Task: { title: [{ text: { content: "Ship" } }] } },
      });
    });

    it("refuses properties under a page parent without calling Notion", async () => {
      const fetchImpl = vi.fn<NotionFetch>();
      const result = await run(voiceWith(fetchImpl), "create_page", {
        parent_type: "page", parent_id: PAGE_ID, title: "x", properties: { Status: { status: { name: "a" } } },
      });
      expect(result.is_error).toBe(true);
      expect(result.content).toMatch(/only to a database parent/);
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("reports a database with no title property", async () => {
      const fetchImpl = fakeFetch(json(200, { ...DATABASE, properties: {} }));
      const result = await run(voiceWith(fetchImpl), "create_page", { parent_type: "database", parent_id: DB_ID, title: "x" });
      expect(result).toEqual({ content: expect.stringMatching(/has no title property/), is_error: true });
    });

    it("passes a failed database lookup on", async () => {
      const fetchImpl = fakeFetch(json(404, { object: "error", code: "object_not_found", message: "nope" }));
      const result = await run(voiceWith(fetchImpl), "create_page", { parent_type: "database", parent_id: DB_ID, title: "x" });
      expect(result.is_error).toBe(true);
      expect(result.content).toMatch(/Connections/);
    });

    it("refuses content over a hundred blocks", async () => {
      const fetchImpl = vi.fn<NotionFetch>();
      const content = Array.from({ length: 101 }, (_, i) => `line ${i}`).join("\n");
      const result = await run(voiceWith(fetchImpl), "create_page", { parent_type: "page", parent_id: PAGE_ID, title: "x", content });
      expect(result.content).toMatch(/101 blocks/);
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("passes a failed create on", async () => {
      const fetchImpl = fakeFetch(json(400, { object: "error", code: "validation_error", message: "bad" }));
      const result = await run(voiceWith(fetchImpl), "create_page", { parent_type: "page", parent_id: PAGE_ID, title: "x" });
      expect(result.is_error).toBe(true);
    });
  });

  describe("append_to_page", () => {
    it("patches the page's children with the converted text", async () => {
      const fetchImpl = fakeFetch(json(200, list([])));
      const result = await run(voiceWith(fetchImpl), "append_to_page", { page_id: PAGE_ID, content: "one\n\ntwo" });
      const { url, init, body } = callOf(fetchImpl);
      expect(url).toBe(`${NOTION_API_BASE}/blocks/${PAGE_UUID}/children`);
      expect(init.method).toBe("PATCH");
      expect(body).toMatchObject({ children: [{ type: "paragraph" }, { type: "paragraph" }] });
      expect(result.content).toBe(`Appended 2 blocks to page ${PAGE_UUID}.`);
    });

    it("says one block, not one blocks", async () => {
      const result = await run(voiceWith(fakeFetch(json(200, list([])))), "append_to_page", { page_id: PAGE_ID, content: "only" });
      expect(result.content).toBe(`Appended 1 block to page ${PAGE_UUID}.`);
    });

    it("refuses blank content and oversized content without calling Notion", async () => {
      const fetchImpl = vi.fn<NotionFetch>();
      expect((await run(voiceWith(fetchImpl), "append_to_page", { page_id: PAGE_ID, content: "\n \n" })).is_error).toBe(true);
      const big = Array.from({ length: 150 }, () => "- x").join("\n");
      expect((await run(voiceWith(fetchImpl), "append_to_page", { page_id: PAGE_ID, content: big })).content).toMatch(/150 blocks/);
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("passes a refusal on", async () => {
      const fetchImpl = fakeFetch(json(403, { object: "error", code: "restricted_resource", message: "no" }));
      const result = await run(voiceWith(fetchImpl), "append_to_page", { page_id: PAGE_ID, content: "x" });
      expect(result.content).toMatch(/capabilit/);
    });
  });

  describe("update_page", () => {
    it("patches only the named properties", async () => {
      const fetchImpl = fakeFetch(json(200, page("Row")));
      const properties = { Status: { status: { name: "Done" } } };
      const result = await run(voiceWith(fetchImpl), "update_page", { page_id: PAGE_ID, properties });
      expect(callOf(fetchImpl).init.method).toBe("PATCH");
      expect(callOf(fetchImpl).body).toEqual({ properties });
      expect(result.content).toBe(`Updated Status on page "Row" (${PAGE_UUID}).`);
    });

    it("refuses an empty set of properties", async () => {
      await expect(run(voiceWith(vi.fn<NotionFetch>()), "update_page", { page_id: PAGE_ID, properties: {} })).rejects.toThrow(/at least one/);
    });

    it("passes a refusal on", async () => {
      const result = await run(voiceWith(fakeFetch(json(409, { code: "conflict_error" }))), "update_page", {
        page_id: PAGE_ID, properties: { A: { number: 1 } },
      });
      expect(result.content).toMatch(/conflicting edit/);
    });
  });

  describe("archive_page", () => {
    it("archives the page and says it can be restored", async () => {
      const fetchImpl = fakeFetch(json(200, page("Old", { archived: true })));
      const result = await run(voiceWith(fetchImpl), "archive_page", { page_id: PAGE_ID });
      expect(callOf(fetchImpl).body).toEqual({ archived: true });
      expect(result.content).toMatch(/Archived page "Old".*Trash/);
    });

    it("passes a refusal on", async () => {
      const result = await run(voiceWith(fakeFetch(json(404, {}))), "archive_page", { page_id: PAGE_ID });
      expect(result.is_error).toBe(true);
    });
  });
});
