import { describe, it, expect, vi, afterEach } from "vitest";

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("../../src/logger.js", () => ({ logger: { debug: vi.fn(), warn } }));

import { fetchRegistry } from "../../src/commands/search.js";

const registry = {
  official: [
    {
      name: "postgres",
      package: "@tuttiai/postgres",
      description: "Query and inspect a PostgreSQL database",
      tags: ["postgres", "sql"],
    },
  ],
  community: [],
};

describe("fetchRegistry", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    warn.mockReset();
  });

  it("lists @tuttiai/postgres with 8 tools when the registry is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

    const voices = await fetchRegistry();
    const postgres = voices.find((v) => v.name === "postgres");

    expect(postgres?.package).toBe("@tuttiai/postgres");
    expect(postgres?.tools).toBe(8);
    expect(voices.some((v) => v.package === "pg")).toBe(false);
  });

  it("falls back to the built-in list when the registry answers with an HTTP error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 503 })));

    const voices = await fetchRegistry();

    expect(voices.find((v) => v.name === "postgres")?.package).toBe("@tuttiai/postgres");
  });

  it("gives postgres 8 tools when the registry is reachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(registry))));

    const voices = await fetchRegistry();

    expect(voices).toHaveLength(1);
    expect(voices[0]?.tools).toBe(8);
    expect(voices[0]?.official).toBe(true);
  });

  it("uses the registry's tools_count and ignores unknown keys, as in the live voices.json", async () => {
    const live = {
      $schema: "./voices.schema.json",
      official: [
        { ...entry("github"), tools_count: 10, repo: "tuttiai/voices", version: "0.3.0", author: "tuttiai", permissions: ["network"] },
        { ...entry("mcp"), tools_count: "dynamic" },
      ],
      community: [],
    };
    serve(JSON.stringify(live));

    const voices = await fetchRegistry();

    expect(voices.map((v) => [v.name, v.tools])).toEqual([["github", 10], ["mcp", 0]]);
    expect(voices[0]).not.toHaveProperty("repo");
    expect(warn).not.toHaveBeenCalled();
  });

  it("gives github 23 tools offline, the count its source builds", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

    const voices = await fetchRegistry();

    expect(voices.find((v) => v.name === "github")?.tools).toBe(23);
    expect(warn).not.toHaveBeenCalled();
  });

  it("falls back with a warning when the body is not JSON", async () => {
    serve("{not json");

    await expectFallback("invalid-json");
  });

  it.each([[[]], [null], [{ official: "x" }]])("falls back with a warning for the shape %j", async (payload) => {
    serve(JSON.stringify(payload));

    await expectFallback();
  });

  it.each([
    [{ name: 5 }, "official[0].name"],
    [{ tags: "a" }, "official[0].tags"],
    [{ tools_count: true }, "official[0].tools_count"],
    [{ tools_count: -1 }, "official[0].tools_count"],
    [{ tools_count: 1.5 }, "official[0].tools_count"],
  ])("falls back with a warning for the field %j", async (field, path) => {
    serve(JSON.stringify({ official: [{ ...entry("github"), ...field }] }));

    await expectFallback(expect.stringContaining(path + ":"));
  });

  it("accepts 500 official entries", async () => {
    serve(JSON.stringify({ official: Array.from({ length: 500 }, (_, i) => entry("v" + i)) }));

    expect(await fetchRegistry()).toHaveLength(500);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    [{ official: Array.from({ length: 501 }, (_, i) => entry("v" + i)) }, "official: expected at most 500 items"],
    [{ community: Array.from({ length: 501 }, (_, i) => entry("v" + i)) }, "community: expected at most 500 items"],
  ])("falls back with a warning for an oversized list", async (payload, reason) => {
    serve(JSON.stringify(payload));

    await expectFallback(reason);
  });

  it("falls back with a warning for an entry with 21 tags", async () => {
    serve(JSON.stringify({ official: [{ ...entry("github"), tags: Array.from({ length: 21 }, () => "t") }] }));

    await expectFallback(expect.stringMatching(/^official\[0\]\.tags:/));
  });

  it("falls back as a whole when one entry of several is invalid", async () => {
    serve(JSON.stringify({ official: [entry("github"), { ...entry("web"), name: 5 }] }));

    await expectFallback(expect.stringMatching(/^official\[1\]\.name:/));
  });

  it("keeps payload values and the URL out of the warning", async () => {
    const hostile = "\u001b[31mghp_secretsecretsecret" + "x".repeat(64);
    serve(JSON.stringify({ official: [{ ...entry("github"), name: hostile }] }));

    await expectFallback();
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain("ghp_");
    expect(logged).not.toContain("\\u001b");
    expect(logged).not.toContain("https://");
  });

  it("does not warn when the registry answers with an HTTP error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 503 })));

    await fetchRegistry();

    expect(warn).not.toHaveBeenCalled();
  });
});

function entry(name: string): Record<string, unknown> {
  return { name, package: "@tuttiai/" + name, description: "A voice", tags: [name] };
}

function serve(body: string): void {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body)));
}

async function expectFallback(reason: unknown = expect.any(String)): Promise<void> {
  const voices = await fetchRegistry();

  expect(voices.map((v) => v.name)).toEqual(["filesystem", "github", "playwright", "postgres"]);
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalledWith({ reason }, "Voice registry response is invalid; using the built-in voice list");
}
