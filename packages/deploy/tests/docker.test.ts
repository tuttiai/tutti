import { describe, it, expect, afterAll } from "vitest";
import { resolve } from "node:path";
import { existsSync, readFileSync, statSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

import { generateDockerBundle } from "../src/targets/docker.js";
import type { DeployManifest } from "../src/types.js";

const created: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(resolve(tmpdir(), "tutti-deploy-docker-"));
  created.push(dir);
  return dir;
}

function baseManifest(overrides: Partial<DeployManifest> = {}): DeployManifest {
  return {
    agent_name: "api",
    target: "docker",
    name: "my-agent",
    region: "auto",
    env: {},
    secrets: [],
    scale: { minInstances: 0, maxInstances: 3 },
    healthCheck: { path: "/health", intervalSeconds: 30 },
    services: { postgres: false, redis: false },
    ...overrides,
  };
}

describe("generateDockerBundle", () => {
  afterAll(() => {
    for (const dir of created) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  it("writes Dockerfile, .dockerignore, docker-compose.yml, and deploy.sh", async () => {
    const dir = tempDir();
    await generateDockerBundle(baseManifest(), dir);

    expect(existsSync(resolve(dir, "Dockerfile"))).toBe(true);
    expect(existsSync(resolve(dir, ".dockerignore"))).toBe(true);
    expect(existsSync(resolve(dir, "docker-compose.yml"))).toBe(true);
    expect(existsSync(resolve(dir, "deploy.sh"))).toBe(true);
  });

  it("creates outDir when it does not yet exist", async () => {
    const parent = tempDir();
    const nested = resolve(parent, "nested", "build");
    expect(existsSync(nested)).toBe(false);

    await generateDockerBundle(baseManifest(), nested);

    expect(existsSync(resolve(nested, "Dockerfile"))).toBe(true);
  });

  it("writes deploy.sh with execute permission", async () => {
    const dir = tempDir();
    await generateDockerBundle(baseManifest(), dir);

    const stat = statSync(resolve(dir, "deploy.sh"));
    // Owner-execute bit set (0o100). Skip on Windows where chmod is a no-op.
    if (process.platform !== "win32") {
      expect(stat.mode & 0o100).toBe(0o100);
    }
  });

  describe("Dockerfile", () => {
    it("includes the standard FROM, WORKDIR, EXPOSE, and CMD", async () => {
      const dir = tempDir();
      await generateDockerBundle(baseManifest(), dir);
      const dockerfile = readFileSync(resolve(dir, "Dockerfile"), "utf-8");

      expect(dockerfile).toContain("FROM node:20-alpine");
      expect(dockerfile).toContain("WORKDIR /app");
      expect(dockerfile).toContain("RUN npm ci --omit=dev");
      expect(dockerfile).toContain("EXPOSE 3000");
      expect(dockerfile).toContain('CMD ["node", "dist/server.js"]');
    });

    it("uses the manifest's health-check path and interval", async () => {
      const dir = tempDir();
      await generateDockerBundle(
        baseManifest({
          healthCheck: { path: "/healthz", intervalSeconds: 15 },
        }),
        dir,
      );
      const dockerfile = readFileSync(resolve(dir, "Dockerfile"), "utf-8");

      expect(dockerfile).toContain("HEALTHCHECK --interval=15s");
      expect(dockerfile).toContain("http://localhost:3000/healthz");
    });

    it("emits ENV directives for declared env vars", async () => {
      const dir = tempDir();
      await generateDockerBundle(
        baseManifest({ env: { LOG_LEVEL: "debug", FEATURE_X: "on" } }),
        dir,
      );
      const dockerfile = readFileSync(resolve(dir, "Dockerfile"), "utf-8");

      expect(dockerfile).toContain('ENV LOG_LEVEL="debug"');
      expect(dockerfile).toContain('ENV FEATURE_X="on"');
    });

    it("translates scale.memory into NODE_OPTIONS --max-old-space-size", async () => {
      const dir = tempDir();
      await generateDockerBundle(
        baseManifest({
          scale: { minInstances: 0, maxInstances: 3, memory: "512mb" },
        }),
        dir,
      );
      const dockerfile = readFileSync(resolve(dir, "Dockerfile"), "utf-8");

      expect(dockerfile).toContain(
        "ENV NODE_OPTIONS=--max-old-space-size=512",
      );
    });

    it("converts gb units to mb in NODE_OPTIONS", async () => {
      const dir = tempDir();
      await generateDockerBundle(
        baseManifest({
          scale: { minInstances: 0, maxInstances: 3, memory: "2gb" },
        }),
        dir,
      );
      const dockerfile = readFileSync(resolve(dir, "Dockerfile"), "utf-8");

      expect(dockerfile).toContain(
        "ENV NODE_OPTIONS=--max-old-space-size=2048",
      );
    });

    it("omits NODE_OPTIONS entirely when no memory limit is set", async () => {
      const dir = tempDir();
      await generateDockerBundle(baseManifest(), dir);
      const dockerfile = readFileSync(resolve(dir, "Dockerfile"), "utf-8");

      expect(dockerfile).not.toContain("NODE_OPTIONS");
    });
  });

  describe(".dockerignore", () => {
    it("excludes node_modules, env files, tests, and the .tutti dir", async () => {
      const dir = tempDir();
      await generateDockerBundle(baseManifest(), dir);
      const ignore = readFileSync(resolve(dir, ".dockerignore"), "utf-8");

      expect(ignore).toContain("node_modules");
      expect(ignore).toContain(".env");
      expect(ignore).toContain(".env.*");
      expect(ignore).toContain("*.test.ts");
      expect(ignore).toContain(".tutti/");
    });
  });

  describe("docker-compose.yml", () => {
    it("emits only the agent service when no infra dependencies are flagged", async () => {
      const dir = tempDir();
      await generateDockerBundle(baseManifest(), dir);
      const compose = readFileSync(
        resolve(dir, "docker-compose.yml"),
        "utf-8",
      );

      expect(compose).toContain("agent:");
      expect(compose).toContain("container_name: my-agent");
      expect(compose).toContain('"3000:3000"');
      expect(compose).not.toContain("postgres:");
      expect(compose).not.toContain("redis:");
      expect(compose).not.toContain("depends_on:");
    });

    it("includes a postgres service and a named volume when services.postgres is true", async () => {
      const dir = tempDir();
      await generateDockerBundle(
        baseManifest({ services: { postgres: true, redis: false } }),
        dir,
      );
      const compose = readFileSync(
        resolve(dir, "docker-compose.yml"),
        "utf-8",
      );

      expect(compose).toContain("postgres:");
      expect(compose).toContain("postgres:16-alpine");
      expect(compose).toContain("postgres-data:/var/lib/postgresql/data");
      expect(compose).toContain("volumes:");
      expect(compose).toContain("  postgres-data:");
      expect(compose).toContain("depends_on:");
      expect(compose).toContain("- postgres");
    });

    it("includes a redis service when services.redis is true", async () => {
      const dir = tempDir();
      await generateDockerBundle(
        baseManifest({ services: { postgres: false, redis: true } }),
        dir,
      );
      const compose = readFileSync(
        resolve(dir, "docker-compose.yml"),
        "utf-8",
      );

      expect(compose).toContain("redis:");
      expect(compose).toContain("redis:7-alpine");
      expect(compose).toContain("- redis");
    });

    it("emits manifest env vars as plaintext and secrets as ${SECRET} refs", async () => {
      const dir = tempDir();
      await generateDockerBundle(
        baseManifest({
          env: { LOG_LEVEL: "info" },
          secrets: ["ANTHROPIC_API_KEY"],
        }),
        dir,
      );
      const compose = readFileSync(
        resolve(dir, "docker-compose.yml"),
        "utf-8",
      );

      expect(compose).toContain("- LOG_LEVEL=info");
      expect(compose).toContain("- ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}");
    });
  });

  describe("deploy.sh", () => {
    it("substitutes the manifest name and references REGISTRY/VERSION env vars", async () => {
      const dir = tempDir();
      await generateDockerBundle(baseManifest({ name: "shipping-agent" }), dir);
      const script = readFileSync(resolve(dir, "deploy.sh"), "utf-8");

      expect(script).toContain("#!/usr/bin/env bash");
      expect(script).toContain("set -euo pipefail");
      expect(script).toContain('NAME="shipping-agent"');
      expect(script).toContain('REGISTRY="${REGISTRY:-');
      expect(script).toContain('VERSION="${VERSION:-latest}"');
      expect(script).toContain('docker build -t "$IMAGE" .');
      expect(script).toContain('docker run --rm "$IMAGE" npm test');
      expect(script).toContain('docker push "$IMAGE"');
    });
  });
});
