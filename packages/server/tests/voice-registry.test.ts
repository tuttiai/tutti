import { describe, it, expect } from "vitest";
import { PermissionGuard } from "@tuttiai/core";
import type { Voice } from "@tuttiai/types";

import { loadVoices } from "../src/voice-loader.js";
import { VOICE_LOADERS } from "../src/voice-registry.js";

/*
 * The real registry, against the real voice packages. Constructing a voice
 * opens no connection, so none of this reaches the network.
 */

const MAIL = { host: "mail.example.com", port: 993, user: "bot", password: "app-password" };

describe("VOICE_LOADERS", () => {
  it("carries exactly the four voices the image ships", () => {
    expect([...VOICE_LOADERS.keys()]).toEqual(["github", "slack", "email", "web"]);
  });

  it("builds each voice from options its own schema accepts", async () => {
    const voices = await loadVoices([
      { voice: "github", options: { token: "ghp_test" } },
      { voice: "slack", options: { token: "xoxb-test" } },
      { voice: "email", options: { imap: MAIL, smtp: { ...MAIL, port: 465 }, from: "Bot <bot@example.com>" } },
      { voice: "web", options: { provider: "duckduckgo", cache: false } },
    ]);
    const byName = new Map(voices.map((voice): [string, Voice] => [voice.name, voice]));
    expect([...byName.keys()]).toEqual(["github", "slack", "email", "web"]);
    expect(byName.get("github")?.tools.map((tool) => tool.name)).toContain("create_pull_request");
    expect(byName.get("web")?.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["web_search", "fetch_url"]),
    );
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
