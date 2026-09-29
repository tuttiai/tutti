import { describe, it, expect, vi } from "vitest";
import type { Tool } from "@tuttiai/types";

import { KnowledgeVoice, type KnowledgeFetch } from "../src/index.js";

const URL_ = "http://control-plane:4849/agent/v1/deployments/d1/agents/lead/knowledge/";
const TOKEN = "agent-token-secret";

const BASES = { bases: [{ handle: "handbook", name: "Handbook", description: null, sources: 2, chunks: 14 }] };
const FOUND = {
  results: [{ base: "handbook", source: "Refunds", title: "Refunds", text: "Refunds within 30 days.", score: 0.03, location: null }],
  mode: "keyword",
  searched: ["handbook"],
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function voiceWith(fetchImpl: KnowledgeFetch, extra: Record<string, unknown> = {}): KnowledgeVoice {
  return new KnowledgeVoice({ url: URL_, token: TOKEN, ...extra }, { fetch: fetchImpl });
}

function tool(voice: KnowledgeVoice, name: string): Tool {
  const found = voice.tools.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`no tool ${name}`);
  return found;
}

const CONTEXT = { session_id: "s", agent_name: "a" };

describe("KnowledgeVoice", () => {
  it("offers two read-only tools and needs only the network", () => {
    const voice = voiceWith(vi.fn<KnowledgeFetch>());
    expect(voice.tools.map((t) => t.name)).toEqual(["list_knowledge_bases", "search_knowledge_bases"]);
    expect(voice.tools.some((t) => t.destructive === true)).toBe(false);
    expect(voice.required_permissions).toEqual(["network"]);
  });

  it("refuses a configuration without a token at construction", () => {
    expect(() => new KnowledgeVoice({ url: URL_, token: "" })).toThrow();
  });

  describe("list_knowledge_bases", () => {
    it("calls GET <url>/bases with the bearer token and returns the bases", async () => {
      const fetchImpl = vi.fn<KnowledgeFetch>().mockResolvedValue(json(200, BASES));
      const result = await tool(voiceWith(fetchImpl), "list_knowledge_bases").execute({}, CONTEXT);
      expect(result.is_error).toBeUndefined();
      expect(JSON.parse(result.content)).toEqual(BASES.bases);
      const [address, init] = fetchImpl.mock.calls[0] ?? [];
      expect(address).toBe("http://control-plane:4849/agent/v1/deployments/d1/agents/lead/knowledge/bases");
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("error");
      expect(init?.headers).toMatchObject({ authorization: `Bearer ${TOKEN}` });
    });

    it("joins the path cleanly however many slashes the url ends in", async () => {
      const fetchImpl = vi.fn<KnowledgeFetch>().mockResolvedValue(json(200, BASES));
      const voice = new KnowledgeVoice({ url: `http://kb.internal/a1${"/".repeat(50_000)}`, token: TOKEN }, { fetch: fetchImpl });
      await tool(voice, "list_knowledge_bases").execute({}, CONTEXT);
      expect(fetchImpl.mock.calls[0]?.[0]).toBe("http://kb.internal/a1/bases");
    });

    it("says so when nothing is shared", async () => {
      const fetchImpl = vi.fn<KnowledgeFetch>().mockResolvedValue(json(200, { bases: [] }));
      const result = await tool(voiceWith(fetchImpl), "list_knowledge_bases").execute({}, CONTEXT);
      expect(result.content).toMatch(/No knowledge base is shared/);
    });
  });

  describe("search_knowledge_bases", () => {
    it("posts the query with the default top_k and returns what was found", async () => {
      const fetchImpl = vi.fn<KnowledgeFetch>().mockResolvedValue(json(200, FOUND));
      const result = await tool(voiceWith(fetchImpl), "search_knowledge_bases").execute({ query: "refunds" }, CONTEXT);
      expect(JSON.parse(result.content)).toEqual(FOUND);
      const init = fetchImpl.mock.calls[0]?.[1];
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({ query: "refunds", top_k: 5 });
    });

    it("passes the bases and top_k the model chose, and the configured default otherwise", async () => {
      const fetchImpl = vi.fn<KnowledgeFetch>().mockResolvedValue(json(200, FOUND));
      const voice = voiceWith(fetchImpl, { default_top_k: 8 });
      await tool(voice, "search_knowledge_bases").execute({ query: "q", bases: ["handbook"] }, CONTEXT);
      expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({ query: "q", top_k: 8, bases: ["handbook"] });
    });

    it("says nothing matched rather than returning an empty list", async () => {
      const fetchImpl = vi.fn<KnowledgeFetch>().mockResolvedValue(json(200, { ...FOUND, results: [] }));
      const result = await tool(voiceWith(fetchImpl), "search_knowledge_bases").execute({ query: "zebra" }, CONTEXT);
      expect(result.content).toMatch(/Nothing in handbook matched "zebra"/);
    });
  });

  describe("failures", () => {
    it("passes on the service's refusal sentence and scrubs the token from it", async () => {
      const fetchImpl = vi.fn<KnowledgeFetch>().mockResolvedValue(json(403, { error: "forbidden", message: `bad ${TOKEN}` }));
      const result = await tool(voiceWith(fetchImpl), "search_knowledge_bases").execute({ query: "q" }, CONTEXT);
      expect(result.is_error).toBe(true);
      expect(result.content).toBe("bad [redacted]");
    });

    it("tells the agent to be redeployed on a bare 401", async () => {
      const fetchImpl = vi.fn<KnowledgeFetch>().mockResolvedValue(new Response("", { status: 401 }));
      const result = await tool(voiceWith(fetchImpl), "list_knowledge_bases").execute({}, CONTEXT);
      expect(result.content).toMatch(/Redeploy the agent/);
    });

    it("names only the service's origin when it cannot be reached", async () => {
      const fetchImpl = vi.fn<KnowledgeFetch>().mockRejectedValue(new TypeError("fetch failed"));
      const result = await tool(voiceWith(fetchImpl), "list_knowledge_bases").execute({}, CONTEXT);
      expect(result.is_error).toBe(true);
      expect(result.content).toContain("http://control-plane:4849");
      expect(result.content).not.toContain("agents/lead");
      expect(result.content).not.toContain(TOKEN);
    });

    it("reports a timeout as one", async () => {
      const timeout = Object.assign(new Error("t"), { name: "TimeoutError" });
      const fetchImpl = vi.fn<KnowledgeFetch>().mockRejectedValue(timeout);
      const result = await tool(voiceWith(fetchImpl, { timeout_ms: 2_000 }), "list_knowledge_bases").execute({}, CONTEXT);
      expect(result.content).toMatch(/no answer within 2000 ms/);
    });

    it("refuses an answer of the wrong shape", async () => {
      const fetchImpl = vi.fn<KnowledgeFetch>().mockResolvedValue(json(200, { hits: [] }));
      const result = await tool(voiceWith(fetchImpl), "search_knowledge_bases").execute({ query: "q" }, CONTEXT);
      expect(result.content).toMatch(/shape this voice does not read/);
    });

    it("refuses an answer that is not JSON", async () => {
      const fetchImpl = vi.fn<KnowledgeFetch>().mockResolvedValue(new Response("<html>", { status: 200 }));
      const result = await tool(voiceWith(fetchImpl), "list_knowledge_bases").execute({}, CONTEXT);
      expect(result.is_error).toBe(true);
    });

    it("words a 404 and a 500 without the service's help", async () => {
      const notFound = vi.fn<KnowledgeFetch>().mockResolvedValue(new Response("", { status: 404 }));
      expect((await tool(voiceWith(notFound), "list_knowledge_bases").execute({}, CONTEXT)).content).toMatch(/does not know this agent/);
      const broken = vi.fn<KnowledgeFetch>().mockResolvedValue(new Response("", { status: 500 }));
      expect((await tool(voiceWith(broken), "list_knowledge_bases").execute({}, CONTEXT)).content).toMatch(/answered 500/);
    });
  });
});
