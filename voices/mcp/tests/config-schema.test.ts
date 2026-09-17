import { describe, it, expect } from "vitest";
import { McpVoiceConfigSchema } from "../src/index.js";

describe("McpVoiceConfigSchema", () => {
  it("accepts a full configuration", () => {
    const config = {
      server: "npx @playwright/mcp",
      args: ["--headless"],
      env: { TOKEN: "x" },
      name: "browser",
    };
    expect(McpVoiceConfigSchema.parse(config)).toEqual(config);
  });

  it("requires server, because there is nothing to bridge without it", () => {
    expect(() => McpVoiceConfigSchema.parse({})).toThrow();
  });

  it("rejects an empty server command", () => {
    expect(() => McpVoiceConfigSchema.parse({ server: "" })).toThrow();
  });

  it("rejects a non-string env value", () => {
    expect(() => McpVoiceConfigSchema.parse({ server: "x", env: { A: 1 } })).toThrow();
  });

  it("rejects an unknown key", () => {
    expect(() => McpVoiceConfigSchema.parse({ server: "x", cwd: "/tmp" })).toThrow();
  });
});
