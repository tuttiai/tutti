import { afterEach, describe, it, expect, vi } from "vitest";

import { NotionVoice, createNotionClient, type NotionFetch } from "../src/index.js";
import { PageSchema } from "../src/notion-schemas.js";
import { scrubSecrets } from "../src/utils/errors.js";
import { PAGE_ID, TOKEN, callOf, fakeFetch, json, page, run, voiceWith } from "./fake-notion.js";

function refusal(status: number, code?: string, message?: string): Response {
  return json(status, { object: "error", status, ...(code === undefined ? {} : { code }), ...(message === undefined ? {} : { message }) });
}

async function getPage(answer: Response): Promise<{ content: string; is_error?: boolean }> {
  return run(voiceWith(fakeFetch(answer)), "get_page", { page_id: PAGE_ID });
}

describe("Notion errors", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("tells the agent to share the page through Connections on a 404", async () => {
    const result = await getPage(refusal(404, "object_not_found", "Could not find page with ID: x."));
    expect(result.is_error).toBe(true);
    expect(result.content).toMatch(/shared with this integration.*Connections/);
    expect(result.content).toContain("Could not find page");
  });

  it.each([
    [401, "unauthorized", /integration token/],
    [403, "restricted_resource", /capabilit/],
    [400, "validation_error", /invalid/],
    [502, "bad_gateway", /having trouble \(502\)/],
    [418, undefined, /answered 418/],
  ])("words a %i with its fix", async (status, code, pattern) => {
    expect((await getPage(refusal(status, code))).content).toMatch(pattern);
  });

  it("names the Retry-After wait on a 429", async () => {
    const result = await getPage(json(429, { code: "rate_limited" }, { "retry-after": "7" }));
    expect(result.content).toMatch(/Wait 7 seconds/);
    expect((await getPage(json(429, { code: "rate_limited" }))).content).toMatch(/a few seconds/);
  });

  it("copes with a refusal whose body is not JSON", async () => {
    const result = await getPage(new Response("<html>", { status: 500 }));
    expect(result).toEqual({ content: expect.stringMatching(/having trouble \(500\)/), is_error: true });
    expect((await getPage(new Response("null", { status: 500 }))).is_error).toBe(true);
  });

  it("refuses an answer of the wrong shape or not JSON", async () => {
    expect((await getPage(json(200, { object: "block" }))).content).toMatch(/shape this voice does not read/);
    expect((await getPage(new Response("<html>", { status: 200 }))).is_error).toBe(true);
  });

  it("reports a network failure and a timeout without throwing", async () => {
    const failed = await run(voiceWith(vi.fn<NotionFetch>().mockRejectedValue(new TypeError("fetch failed"))), "get_page", { page_id: PAGE_ID });
    expect(failed.content).toMatch(/Could not reach Notion.*connection failed/);
    const timeout = Object.assign(new Error("t"), { name: "TimeoutError" });
    const slow = await run(voiceWith(vi.fn<NotionFetch>().mockRejectedValue(timeout)), "get_page", { page_id: PAGE_ID });
    expect(slow.content).toMatch(/no answer within 15000 ms/);
  });

  describe("token", () => {
    it("says how to configure the voice when there is no token anywhere", async () => {
      vi.stubEnv("NOTION_TOKEN", "");
      const fetchImpl = vi.fn<NotionFetch>();
      const result = await run(new NotionVoice({}, { fetch: fetchImpl }), "search", {});
      expect(result).toEqual({ content: expect.stringMatching(/NOTION_TOKEN/), is_error: true });
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("falls back to NOTION_TOKEN", async () => {
      vi.stubEnv("NOTION_TOKEN", "secret_fromenvironment0123456789");
      const fetchImpl = fakeFetch(json(200, page("A")));
      await run(new NotionVoice({}, { fetch: fetchImpl }), "get_page", { page_id: PAGE_ID });
      expect(callOf(fetchImpl).init.headers).toMatchObject({ authorization: "Bearer secret_fromenvironment0123456789" });
    });

    it("prefers the token option to the environment", async () => {
      vi.stubEnv("NOTION_TOKEN", "secret_fromenvironment0123456789");
      const fetchImpl = fakeFetch(json(200, page("A")));
      await run(voiceWith(fetchImpl), "get_page", { page_id: PAGE_ID });
      expect(callOf(fetchImpl).init.headers).toMatchObject({ authorization: `Bearer ${TOKEN}` });
    });
  });

  describe("security", () => {
    it("scrubs the token, and any other Notion secret, from Notion's own words", async () => {
      const result = await getPage(refusal(401, "unauthorized", `API token ${TOKEN} is invalid; also secret_abcdefghijklmnopqrstuvwxyz`));
      expect(result.content).not.toContain(TOKEN);
      expect(result.content).not.toContain("secret_abcdefghijklmnopqrstuvwxyz");
      expect(result.content).toContain("[REDACTED]");
    });

    it("never puts the token in any result, whatever the outcome", async () => {
      const answers = [json(200, page("A")), refusal(404, "object_not_found", TOKEN), new Response("x", { status: 500 })];
      for (const answer of answers) expect((await getPage(answer)).content).not.toContain(TOKEN);
      const failed = await run(voiceWith(vi.fn<NotionFetch>().mockRejectedValue(new Error(TOKEN))), "get_page", { page_id: PAGE_ID });
      expect(failed.content).not.toContain(TOKEN);
    });

    it("shortens Notion's sentence", async () => {
      const result = await getPage(refusal(400, "validation_error", "x".repeat(5_000)));
      expect(result.content.length).toBeLessThan(700);
    });

    it("scrubs a token of any shape, and leaves text without one alone", () => {
      expect(scrubSecrets("odd-token-shape here", "odd-token-shape")).toBe("[REDACTED] here");
      expect(scrubSecrets("plain", "")).toBe("plain");
    });

    it("only ever calls api.notion.com", async () => {
      const fetchImpl = fakeFetch(json(200, page("A")));
      const client = createNotionClient({ token: TOKEN, fetch: fetchImpl });
      await client.request({ method: "GET", path: "/pages/x", what: "page x" }, PageSchema);
      expect(callOf(fetchImpl).url.startsWith("https://api.notion.com/v1/")).toBe(true);
    });
  });
});
