import { describe, it, expect } from "vitest";
import { McpVoice } from "../src/index.js";

describe("McpVoice", () => {
  describe("constructor", () => {
    it("derives voice name from server command when no name provided", () => {
      const voice = new McpVoice({ server: "npx @playwright/mcp" });
      expect(voice.name).toBe("mcp-mcp");
    });

    it("uses explicit name when provided", () => {
      const voice = new McpVoice({ server: "npx @playwright/mcp", name: "browser" });
      expect(voice.name).toBe("browser");
    });

    it("handles server commands with a path", () => {
      const voice = new McpVoice({ server: "/usr/local/bin/mcp-server" });
      expect(voice.name).toBe("mcp-mcp-server");
    });

    it("declares network permission", () => {
      const voice = new McpVoice({ server: "any" });
      expect(voice.required_permissions).toEqual(["network"]);
    });

    it("starts with empty tools array", () => {
      const voice = new McpVoice({ server: "any" });
      expect(voice.tools).toEqual([]);
    });

    it("has MCP bridge description", () => {
      const voice = new McpVoice({ server: "any" });
      expect(voice.description).toBe("MCP server bridge");
    });
  });

  describe("teardown", () => {
    it("is safe to call before setup", async () => {
      const voice = new McpVoice({ server: "any" });
      await expect(voice.teardown()).resolves.toBeUndefined();
    });

    it("resets tools to empty after teardown", async () => {
      const voice = new McpVoice({ server: "any" });
      await voice.teardown();
      expect(voice.tools).toEqual([]);
    });
  });
});
