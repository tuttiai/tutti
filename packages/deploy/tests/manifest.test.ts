import { describe, it, expect, afterAll } from "vitest";
import { resolve } from "node:path";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";

import { buildDeployManifest } from "../src/manifest.js";

const TMP_DIR = resolve(import.meta.dirname ?? __dirname, ".tmp-deploy-manifest");

let fileCounter = 0;

function writeScore(agentsBlock: string, extraScoreFields = ""): string {
  mkdirSync(TMP_DIR, { recursive: true });
  fileCounter += 1;
  // Unique filename per call so Node's ESM loader cache doesn't return a
  // previous test's module.
  const path = resolve(TMP_DIR, `score-${String(fileCounter)}.mjs`);
  const content = `export default {
    provider: { chat: async () => ({}) },
    ${extraScoreFields}
    agents: ${agentsBlock},
  };`;
  writeFileSync(path, content, "utf-8");
  return path;
}

describe("buildDeployManifest", () => {
  afterAll(() => {
    try {
      rmSync(TMP_DIR, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  describe("happy path", () => {
    it("resolves a minimal deploy config and fills in every default", async () => {
      const path = writeScore(`{
        api: {
          name: "api",
          system_prompt: "hello",
          voices: [],
          deploy: { target: "fly" },
        },
      }`);

      const manifest = await buildDeployManifest(path);

      expect(manifest).toEqual({
        agent_name: "api",
        target: "fly",
        name: "api", // inferred from agent name
        region: "auto",
        env: {},
        secrets: [],
        scale: { minInstances: 0, maxInstances: 3 },
        healthCheck: { path: "/health", intervalSeconds: 30 },
        services: { postgres: false, redis: false },
      });
    });

    it("flags services.postgres when the score uses postgres memory", async () => {
      const path = writeScore(`{
        api: {
          name: "api",
          system_prompt: "hello",
          voices: [],
          deploy: { target: "docker" },
        },
      }`, `memory: { provider: "postgres", url: "postgres://localhost/db" },`);

      const manifest = await buildDeployManifest(path);
      expect(manifest.services).toEqual({ postgres: true, redis: false });
    });

    it("flags services.redis when the score uses redis memory", async () => {
      const path = writeScore(`{
        api: {
          name: "api",
          system_prompt: "hello",
          voices: [],
          deploy: { target: "docker" },
        },
      }`, `memory: { provider: "redis", url: "redis://localhost:6379/0" },`);

      const manifest = await buildDeployManifest(path);
      expect(manifest.services).toEqual({ postgres: false, redis: true });
    });

    it("flags services.postgres when an agent's durable store is postgres", async () => {
      const path = writeScore(`{
        api: {
          name: "api",
          system_prompt: "hello",
          voices: [],
          durable: { store: "postgres" },
          deploy: { target: "docker" },
        },
      }`);

      const manifest = await buildDeployManifest(path);
      expect(manifest.services.postgres).toBe(true);
    });

    it("ignores durable: true (memory defaults)", async () => {
      const path = writeScore(`{
        api: {
          name: "api",
          system_prompt: "hello",
          voices: [],
          durable: true,
          deploy: { target: "docker" },
        },
      }`);

      const manifest = await buildDeployManifest(path);
      expect(manifest.services).toEqual({ postgres: false, redis: false });
    });

    it("preserves user-supplied values without overriding with defaults", async () => {
      const path = writeScore(`{
        worker: {
          name: "worker",
          system_prompt: "hello",
          voices: [],
          deploy: {
            target: "cloudflare",
            name: "my-worker",
            region: "ams",
            env: { LOG_LEVEL: "debug", FEATURE_X: "on" },
            secrets: ["DATABASE_URL", "STRIPE_KEY"],
            scale: { minInstances: 1, maxInstances: 10, memory: "512mb" },
            healthCheck: { path: "/healthz", intervalSeconds: 15 },
          },
        },
      }`);

      const manifest = await buildDeployManifest(path);

      expect(manifest.target).toBe("cloudflare");
      expect(manifest.name).toBe("my-worker");
      expect(manifest.region).toBe("ams");
      expect(manifest.env).toEqual({ LOG_LEVEL: "debug", FEATURE_X: "on" });
      expect(manifest.secrets).toEqual(["DATABASE_URL", "STRIPE_KEY"]);
      expect(manifest.scale).toEqual({
        minInstances: 1,
        maxInstances: 10,
        memory: "512mb",
      });
      expect(manifest.healthCheck).toEqual({
        path: "/healthz",
        intervalSeconds: 15,
      });
    });

    it("partially fills defaults when only some scale fields are supplied", async () => {
      const path = writeScore(`{
        api: {
          name: "api",
          system_prompt: "hello",
          voices: [],
          deploy: { target: "docker", scale: { maxInstances: 5 } },
        },
      }`);

      const manifest = await buildDeployManifest(path);

      expect(manifest.scale).toEqual({ minInstances: 0, maxInstances: 5 });
    });

    it("ignores agents without a deploy block", async () => {
      const path = writeScore(`{
        helper: { name: "helper", system_prompt: "h", voices: [] },
        api: {
          name: "api",
          system_prompt: "hello",
          voices: [],
          deploy: { target: "railway" },
        },
      }`);

      const manifest = await buildDeployManifest(path);

      expect(manifest.agent_name).toBe("api");
      expect(manifest.target).toBe("railway");
    });
  });

  describe("score-level errors", () => {
    it("rejects a score with no deployable agents", async () => {
      const path = writeScore(`{
        bot: { name: "bot", system_prompt: "hello", voices: [] },
      }`);

      await expect(buildDeployManifest(path)).rejects.toThrow(
        "no deployable agents",
      );
    });

    it("rejects a score with multiple deployable agents", async () => {
      const path = writeScore(`{
        api: {
          name: "api",
          system_prompt: "hello",
          voices: [],
          deploy: { target: "fly" },
        },
        worker: {
          name: "worker",
          system_prompt: "hello",
          voices: [],
          deploy: { target: "cloudflare" },
        },
      }`);

      await expect(buildDeployManifest(path)).rejects.toThrow(
        /2 agents with deploy configs/,
      );
    });

    it("propagates the underlying score validation error for invalid scores", async () => {
      // Empty agents → fails the standard score validator before deploy
      // logic ever runs.
      const path = writeScore(`{}`);

      await expect(buildDeployManifest(path)).rejects.toThrow(
        "Invalid score file",
      );
    });
  });

  describe("deploy-block validation", () => {
    it("rejects an unknown target", async () => {
      const path = writeScore(`{
        api: {
          name: "api",
          system_prompt: "hello",
          voices: [],
          deploy: { target: "kubernetes" },
        },
      }`);

      await expect(buildDeployManifest(path)).rejects.toThrow(/target/);
    });

    it("rejects an invalid deployment name", async () => {
      const path = writeScore(`{
        api: {
          name: "api",
          system_prompt: "hello",
          voices: [],
          deploy: { target: "docker", name: "Has_Underscore" },
        },
      }`);

      await expect(buildDeployManifest(path)).rejects.toThrow(/name/);
    });

    it("rejects env var names that are not POSIX-shaped", async () => {
      const path = writeScore(`{
        api: {
          name: "api",
          system_prompt: "hello",
          voices: [],
          deploy: {
            target: "docker",
            env: { "lowercase": "x" },
          },
        },
      }`);

      await expect(buildDeployManifest(path)).rejects.toThrow(/env/);
    });

    it("rejects scale.maxInstances < scale.minInstances", async () => {
      const path = writeScore(`{
        api: {
          name: "api",
          system_prompt: "hello",
          voices: [],
          deploy: {
            target: "docker",
            scale: { minInstances: 5, maxInstances: 2 },
          },
        },
      }`);

      await expect(buildDeployManifest(path)).rejects.toThrow(
        /maxInstances/,
      );
    });

    it("rejects an unknown top-level field", async () => {
      const path = writeScore(`{
        api: {
          name: "api",
          system_prompt: "hello",
          voices: [],
          deploy: { target: "docker", typo_field: true },
        },
      }`);

      await expect(buildDeployManifest(path)).rejects.toThrow();
    });

    it("rejects a malformed memory string", async () => {
      const path = writeScore(`{
        api: {
          name: "api",
          system_prompt: "hello",
          voices: [],
          deploy: {
            target: "docker",
            scale: { memory: "loads" },
          },
        },
      }`);

      await expect(buildDeployManifest(path)).rejects.toThrow(/memory/);
    });
  });

  describe("env / secrets validation", () => {
    it("rejects a name that appears in both env and secrets", async () => {
      const path = writeScore(`{
        api: {
          name: "api",
          system_prompt: "hello",
          voices: [],
          deploy: {
            target: "docker",
            env: { DATABASE_URL: "postgres://localhost/db" },
            secrets: ["DATABASE_URL"],
          },
        },
      }`);

      await expect(buildDeployManifest(path)).rejects.toThrow(
        /both an env var and a secret/,
      );
    });

    it("rejects an env value that looks like an Anthropic API key", async () => {
      // Use a syntactically-shaped key — no real credential involved.
      const fakeKey = "sk-ant-" + "a".repeat(40);
      const path = writeScore(`{
        api: {
          name: "api",
          system_prompt: "hello",
          voices: [],
          deploy: {
            target: "docker",
            env: { ANTHROPIC_API_KEY: "${fakeKey}" },
          },
        },
      }`);

      await expect(buildDeployManifest(path)).rejects.toThrow(/API key/);
    });

    it("rejects an env value that looks like an OpenAI API key", async () => {
      const fakeKey = "sk-" + "b".repeat(40);
      const path = writeScore(`{
        api: {
          name: "api",
          system_prompt: "hello",
          voices: [],
          deploy: {
            target: "docker",
            env: { OPENAI_API_KEY: "${fakeKey}" },
          },
        },
      }`);

      await expect(buildDeployManifest(path)).rejects.toThrow(/API key/);
    });
  });
});
