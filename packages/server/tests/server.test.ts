import { describe, it, expect, afterEach } from "vitest";

import { createServer } from "../src/index.js";
import type { ServerConfig } from "../src/config.js";
import type { AgentConfig } from "@tuttiai/types";

const stubAgent: AgentConfig = {
  name: "stub",
  system_prompt: "You are a stub agent.",
  model: "claude-sonnet-4-5",
  voices: [],
};

function baseConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    port: 3847,
    host: "127.0.0.1",
    agent_config: stubAgent,
    ...overrides,
  };
}

describe("createServer", () => {
  let app: ReturnType<typeof createServer> | undefined;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  describe("GET /health", () => {
    it("returns 200 without authentication", async () => {
      app = createServer(baseConfig({ api_key: "secret-test-key" }));

      const response = await app.inject({ method: "GET", url: "/health" });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: "ok" });
    });

    it("returns 200 even when no api_key is configured", async () => {
      app = createServer(baseConfig());

      const response = await app.inject({ method: "GET", url: "/health" });

      expect(response.statusCode).toBe(200);
    });
  });

  describe("startup", () => {
    it("binds and closes on an ephemeral port", async () => {
      app = createServer(baseConfig({ port: 0, api_key: "secret-test-key" }));

      const address = await app.listen({ port: 0, host: "127.0.0.1" });

      expect(typeof address).toBe("string");
      expect(address).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    });
  });
});
