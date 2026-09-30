import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { afterEach, describe, it, expect, vi } from "vitest";
import { PermissionGuard } from "@tuttiai/core";
import type { Voice } from "@tuttiai/types";

import { loadVoices } from "../src/voice-loader.js";
import { VOICE_LOADERS } from "../src/voice-registry.js";

/*
 * The real registry, against the real voice packages. Constructing a voice
 * opens no connection, so none of this reaches the network.
 */

const MAIL = { host: "mail.example.com", port: 993, user: "bot", password: "app-password" };

const EVERY_VOICE = [
  "github", "slack", "email", "web", "discord", "telegram", "whatsapp", "twitter",
  "stripe", "postgres", "rag", "filesystem", "playwright", "sandbox", "mcp", "knowledge",
  "notion",
];

describe("VOICE_LOADERS", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("carries every voice the framework ships", async () => {
    expect([...VOICE_LOADERS.keys()]).toEqual(EVERY_VOICE);
    const shipped = await readdir(fileURLToPath(new URL("../../../voices", import.meta.url)));
    expect([...VOICE_LOADERS.keys()].sort()).toEqual(shipped.sort());
  });

  // The first import of all fifteen voice packages is the whole cost: under a second locally, but
  // past vitest's 5 s default on a cold CI runner with coverage on. It opens no connection, so a
  // longer ceiling hides no hang that could reach the network.
  it("builds each voice from options its own schema accepts", async () => {
    const voices = await loadVoices([
      { voice: "github", options: { token: "ghp_test" } },
      { voice: "slack", options: { token: "xoxb-test" } },
      { voice: "email", options: { imap: MAIL, smtp: { ...MAIL, port: 465 }, from: "Bot <bot@example.com>" } },
      { voice: "web", options: { provider: "duckduckgo", cache: false } },
      { voice: "discord", options: { token: "discord-test" } },
      { voice: "telegram", options: { token: "1:telegram-test" } },
      { voice: "whatsapp", options: { phoneNumberId: "100", accessToken: "wa-test" } },
      { voice: "twitter", options: { bearer_token: "bearer-test" } },
      { voice: "stripe", options: { api_key: "sk_test_x" } },
      { voice: "postgres", options: { connection_string: "postgres://u:p@db.example.com:5432/app" } },
      { voice: "rag", options: { collection: "docs", embeddings: { provider: "openai", api_key: "sk-test" }, storage: { provider: "memory" } } },
      { voice: "filesystem", options: {} },
      { voice: "playwright", options: { headless: true } },
      { voice: "sandbox", options: { allowed_languages: ["python"] } },
      { voice: "mcp", options: { server: "npx some-mcp-server" } },
      { voice: "knowledge", options: { url: "http://control-plane:4849/agent/v1/knowledge", token: "agent-test" } },
      { voice: "notion", options: { token: "ntn_test" } },
    ]);
    const byName = new Map(voices.map((voice): [string, Voice] => [voice.name, voice]));
    expect(byName.get("github")?.tools.map((tool) => tool.name)).toContain("create_pull_request");
    expect(byName.get("web")?.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["web_search", "fetch_url"]),
    );
    expect(byName.get("stripe")?.tools.find((tool) => tool.name === "create_refund")?.destructive).toBe(true);
    expect(byName.get("notion")?.tools.find((tool) => tool.name === "archive_page")?.destructive).toBe(true);
    // Both build their tools in setup(), which opens nothing until a run.
    expect(byName.get("sandbox")?.tools).toEqual([]);
    expect(byName.get("mcp-some-mcp-server")?.tools).toEqual([]);
  }, 30_000);

  it("narrows sandbox to the tools it builds in setup", async () => {
    const [sandbox] = await loadVoices([{ voice: "sandbox", options: {}, only: ["execute_code"] }]);
    try {
      await sandbox?.setup?.({ session_id: "narrow-sandbox", agent_name: "coder" });
      expect(sandbox?.tools.map((tool) => tool.name)).toEqual(["execute_code"]);
    } finally {
      await sandbox?.teardown?.();
    }
  });

  it("refuses a stored option naming the browser binary", async () => {
    await expect(
      loadVoices([{ voice: "playwright", options: { executablePath: "/bin/sh" } }]),
    ).rejects.toThrow(/Voice "playwright" refused its options: \(options\) \(unrecognized_keys\)/);
  });

  it("builds playwright whether or not the image names a browser", async () => {
    vi.stubEnv("TUTTI_CHROMIUM_PATH", "/usr/bin/chromium");
    const [named] = await loadVoices([{ voice: "playwright", options: {} }]);
    vi.stubEnv("TUTTI_CHROMIUM_PATH", "");
    const [unnamed] = await loadVoices([{ voice: "playwright", options: {} }]);
    expect(named?.tools.map((tool) => tool.name)).toContain("navigate");
    expect(unnamed?.tools.map((tool) => tool.name)).toContain("navigate");
  });

  it("refuses options the voice's schema does not know", async () => {
    await expect(loadVoices([{ voice: "github", options: { tokenn: "ghp_test" } }])).rejects.toThrow(
      /Voice "github" refused its options/,
    );
  });

  it("refuses email without its required endpoints", async () => {
    await expect(loadVoices([{ voice: "email", options: { from: "a@b.c" } }])).rejects.toThrow(
      /imap \(invalid_type\), smtp \(invalid_type\)/,
    );
  });

  it("narrows github to its read tools", async () => {
    const [github] = await loadVoices([
      { voice: "github", options: { token: "ghp_test" }, only: ["get_repository", "list_issues"] },
    ]);
    expect(github?.tools.map((tool) => tool.name)).toEqual(["list_issues", "get_repository"]);
  });

  it("is refused by the permission guard when network is not granted", async () => {
    const [web] = await loadVoices([{ voice: "web", options: {} }]);
    expect(web).toBeDefined();
    if (web === undefined) return;
    expect(() => PermissionGuard.check(web, [])).toThrow(/requires permissions not granted: network/);
    expect(() => PermissionGuard.check(web, ["network"])).not.toThrow();
  });
});
