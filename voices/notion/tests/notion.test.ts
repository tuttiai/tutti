import { describe, it, expect, vi } from "vitest";
import type { Voice } from "@tuttiai/types";

import { NOTION_API_BASE, NOTION_VERSION, NotionVoice, type NotionFetch } from "../src/index.js";
import { DB_ID, DB_UUID, PAGE_ID, PAGE_UUID, TOKEN, block, callOf, fakeFetch, json, list, page, rich, run, voiceWith } from "./fake-notion.js";

describe("NotionVoice", () => {
  describe("contract", () => {
    it("implements Voice with eight tools and needs only the network", () => {
      const voice: Voice = voiceWith(vi.fn<NotionFetch>());
      expect(voice.name).toBe("notion");
      expect(voice.required_permissions).toEqual(["network"]);
      expect(voice.tools.map((t) => t.name)).toEqual([
        "search", "get_page", "get_page_body", "query_database",
        "create_page", "append_to_page", "update_page", "archive_page",
      ]);
      for (const tool of voice.tools) {
        expect(tool.description.length).toBeGreaterThan(20);
        expect(typeof tool.execute).toBe("function");
        expect(typeof tool.parameters.safeParse).toBe("function");
      }
    });

    it("marks every write destructive and no read", () => {
      const voice = voiceWith(vi.fn<NotionFetch>());
      expect(voice.tools.filter((t) => t.destructive === true).map((t) => t.name)).toEqual(["create_page", "append_to_page", "update_page", "archive_page"]);
    });

    it("refuses an unknown option at construction", () => {
      // A deliberately mistyped option, as a stored document could carry, to prove the runtime check.
      expect(() => new NotionVoice({ tokens: TOKEN } as never)).toThrow();
    });

    it("opens nothing at construction", () => {
      const fetchImpl = vi.fn<NotionFetch>();
      voiceWith(fetchImpl);
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  describe("requests", () => {
    it("sends the bearer token, the pinned version and refuses redirects", async () => {
      const fetchImpl = fakeFetch(json(200, page("Roadmap")));
      await run(voiceWith(fetchImpl), "get_page", { page_id: PAGE_ID });
      const { url, init } = callOf(fetchImpl);
      expect(url).toBe(`${NOTION_API_BASE}/pages/${PAGE_UUID}`);
      expect(init.method).toBe("GET");
      expect(init.redirect).toBe("error");
      expect(init.headers).toMatchObject({ authorization: `Bearer ${TOKEN}`, "notion-version": NOTION_VERSION });
      expect(NOTION_VERSION).toBe("2022-06-28");
    });
  });

  describe("search", () => {
    it("posts the query and filter, and returns ids, titles and links", async () => {
      const database = { object: "database", id: DB_UUID, url: "https://www.notion.so/db", title: rich("Tasks"), properties: {} };
      const fetchImpl = fakeFetch(json(200, list([page("Roadmap"), database], "cur2")));
      const result = await run(voiceWith(fetchImpl), "search", { query: "road", filter: "page", page_size: 5 });
      expect(callOf(fetchImpl).body).toEqual({ query: "road", filter: { property: "object", value: "page" }, page_size: 5 });
      const parsed: unknown = JSON.parse(result.content);
      expect(parsed).toMatchObject({
        results: [{ object: "page", id: PAGE_UUID, title: "Roadmap" }, { object: "database", id: DB_UUID, title: "Tasks" }],
        next_cursor: "cur2",
      });
    });

    it("sends no query when none is given and passes the cursor on", async () => {
      const fetchImpl = fakeFetch(json(200, list([page("A")])));
      await run(voiceWith(fetchImpl), "search", { start_cursor: "abc" });
      expect(callOf(fetchImpl).body).toEqual({ page_size: 10, start_cursor: "abc" });
    });

    it("says how to share a page when nothing matches", async () => {
      const result = await run(voiceWith(fakeFetch(json(200, list([])))), "search", { query: "zebra" });
      expect(result.is_error).toBeUndefined();
      expect(result.content).toMatch(/Connections menu/);
    });
  });

  describe("get_page", () => {
    it("returns the title and every property as text", async () => {
      const properties = {
        Name: { type: "title", title: rich("Launch") },
        Status: { type: "status", status: { name: "Doing" } },
        Tags: { type: "multi_select", multi_select: [{ name: "a" }, { name: "b" }] },
        Points: { type: "number", number: 3 },
        Done: { type: "checkbox", checkbox: false },
        Due: { type: "date", date: { start: "2026-10-01", end: "2026-10-02" } },
        Ref: { type: "unique_id", unique_id: { prefix: "T", number: 7 } },
        Score: { type: "formula", formula: { type: "number", number: 42 } },
        Owner: { type: "people", people: [{ name: "Ada" }] },
        Link: { type: "relation", relation: [{ id: "r1" }] },
        Made: { type: "created_by", created_by: { id: "u1" } },
      };
      const fetchImpl = fakeFetch(json(200, page("Launch", { properties })));
      const result = await run(voiceWith(fetchImpl), "get_page", { page_id: `https://www.notion.so/acme/Launch-${PAGE_ID}` });
      expect(JSON.parse(result.content)).toMatchObject({
        id: PAGE_UUID,
        title: "Launch",
        archived: false,
        properties: {
          Name: "Launch", Status: "Doing", Tags: "a, b", Points: "3", Done: "false", Due: "2026-10-01 to 2026-10-02",
          Ref: "T-7", Score: "42", Owner: "Ada", Link: "r1", Made: "[created_by]",
        },
      });
    });

    it("refuses an id that is not one before any request", async () => {
      const fetchImpl = vi.fn<NotionFetch>();
      await expect(run(voiceWith(fetchImpl), "get_page", { page_id: "../../users" })).rejects.toThrow(/Not a Notion page id/);
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  describe("get_page_body", () => {
    it("renders the blocks and pages through the children up to max_blocks", async () => {
      const first = list([block("heading_1", { rich_text: rich("Plan") }), block("paragraph", { rich_text: rich("Intro") })], "c2");
      const second = list([block("bulleted_list_item", { rich_text: rich("ship") }), block("divider", {})], "c3");
      const fetchImpl = fakeFetch(json(200, first), json(200, second));
      const result = await run(voiceWith(fetchImpl), "get_page_body", { page_id: PAGE_UUID, max_blocks: 4 });
      expect(result.content).toBe("# Plan\nIntro\n- ship\n---\n\n(stopped at 4 blocks; raise max_blocks to read further)");
      expect(callOf(fetchImpl, 0).url).toBe(`${NOTION_API_BASE}/blocks/${PAGE_UUID}/children?page_size=4`);
      expect(callOf(fetchImpl, 1).url).toBe(`${NOTION_API_BASE}/blocks/${PAGE_UUID}/children?page_size=2&start_cursor=c2`);
    });

    it("says an empty page is empty", async () => {
      const result = await run(voiceWith(fakeFetch(json(200, list([])))), "get_page_body", { page_id: PAGE_ID });
      expect(result.content).toBe(`Page ${PAGE_UUID} has no content.`);
    });

    it("stops at the first failed page", async () => {
      const fetchImpl = fakeFetch(json(200, list([block("paragraph", { rich_text: rich("a") })], "c2")), json(500, {}));
      const result = await run(voiceWith(fetchImpl), "get_page_body", { page_id: PAGE_ID });
      expect(result.is_error).toBe(true);
    });
  });

  describe("query_database", () => {
    it("posts the filter and sorts and returns each row", async () => {
      const fetchImpl = fakeFetch(json(200, list([page("Row")])));
      const filter = { property: "Status", status: { equals: "Done" } };
      const sorts = [{ property: "Due", direction: "ascending" }];
      const result = await run(voiceWith(fetchImpl), "query_database", { database_id: DB_ID, filter, sorts });
      expect(callOf(fetchImpl).url).toBe(`${NOTION_API_BASE}/databases/${DB_UUID}/query`);
      expect(callOf(fetchImpl).body).toEqual({ filter, sorts, page_size: 20 });
      expect(JSON.parse(result.content)).toMatchObject({ results: [{ title: "Row", properties: { Name: "Row" } }], next_cursor: null });
    });

    it("refuses a filter that is not an object", async () => {
      const voice = voiceWith(vi.fn<NotionFetch>());
      await expect(run(voice, "query_database", { database_id: DB_ID, filter: "Status = Done" })).rejects.toThrow();
    });

    it("says when nothing matched", async () => {
      const result = await run(voiceWith(fakeFetch(json(200, list([])))), "query_database", { database_id: DB_ID, start_cursor: "x" });
      expect(result.content).toBe(`No rows in database ${DB_UUID} matched.`);
    });
  });
});
