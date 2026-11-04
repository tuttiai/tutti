import { describe, it, expect, vi, afterEach } from "vitest";
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
});
