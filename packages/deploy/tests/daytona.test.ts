import { describe, it, expect, afterAll } from "vitest";
import { resolve } from "node:path";
import {
  existsSync,
  readFileSync,
  statSync,
  rmSync,
  mkdtempSync,
} from "node:fs";
import { tmpdir } from "node:os";

import {
  buildDevcontainer,
  buildSnapshotsYaml,
  buildDaytonaGitignore,
  buildDaytonaScript,
  generateDaytonaBundle,
} from "../src/targets/daytona.js";
import type { DeployManifest } from "../src/types.js";

const created: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(resolve(tmpdir(), "tutti-deploy-daytona-"));
  created.push(dir);
  return dir;
}

function baseManifest(overrides: Partial<DeployManifest> = {}): DeployManifest {
  return {
    agent_name: "api",
    target: "daytona",
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

describe("buildDevcontainer", () => {
  it("uses the typescript-node:22 base image", () => {
    const json = buildDevcontainer(baseManifest());
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(parsed["image"]).toBe(
      "mcr.microsoft.com/devcontainers/typescript-node:22",
    );
  });

  it("declares a postCreateCommand that installs tutti-ai", () => {
    const json = buildDevcontainer(baseManifest());
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(parsed["postCreateCommand"]).toBe("npm install -g tutti-ai@latest");
  });

  it("forwards port 3000 and only 3000 (Studio is not started by daytona.sh)", () => {
    const json = buildDevcontainer(baseManifest());
    const parsed = JSON.parse(json) as { forwardPorts: number[] };
    expect(parsed.forwardPorts).toEqual([3000]);
    expect(parsed.forwardPorts).not.toContain(4747);
  });

  it("uses the manifest name as the devcontainer name", () => {
    const json = buildDevcontainer(baseManifest({ name: "marketing-agent" }));
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(parsed["name"]).toBe("marketing-agent");
  });

  it("mirrors manifest.env into containerEnv verbatim", () => {
    const json = buildDevcontainer(
      baseManifest({ env: { LOG_LEVEL: "debug", FEATURE_X: "on" } }),
    );
    const parsed = JSON.parse(json) as { containerEnv: Record<string, string> };
    expect(parsed.containerEnv).toEqual({ LOG_LEVEL: "debug", FEATURE_X: "on" });
  });

  it("emits an empty containerEnv object when no env vars are declared", () => {
    const json = buildDevcontainer(baseManifest());
    const parsed = JSON.parse(json) as { containerEnv: Record<string, string> };
    expect(parsed.containerEnv).toEqual({});
  });

  it("produces stable, pretty-printed JSON ending with a newline", () => {
    const json = buildDevcontainer(baseManifest());
    expect(json.endsWith("\n")).toBe(true);
    // Two-space indent is the devcontainer convention used elsewhere in the repo.
    expect(json).toContain('  "image":');
  });
});

describe("buildSnapshotsYaml", () => {
  it("includes the hibernation knobs requested by the deploy spec", () => {
    const yaml = buildSnapshotsYaml();
    expect(yaml).toContain("idle_minutes_until_hibernate: 5");
    expect(yaml).toContain("auto_resume: true");
  });

  it("warns that the schema is unverified so users do not assume it works", () => {
    const yaml = buildSnapshotsYaml();
    expect(yaml).toContain("UNVERIFIED SCHEMA");
    expect(yaml).toContain("TODO(deploy/daytona)");
  });
});

describe("buildDaytonaGitignore", () => {
  it("ignores generated runtime state but not the checked-in config", () => {
    const txt = buildDaytonaGitignore();
    expect(txt).toContain(".daytona/state/");
    expect(txt).toContain(".daytona/logs/");
    expect(txt).not.toMatch(/^\.devcontainer\/\s*$/m);
    expect(txt).not.toMatch(/^\.daytona\/\s*$/m);
  });
});

describe("buildDaytonaScript", () => {
  it("creates a workspace without auto-opening an IDE", () => {
    const sh = buildDaytonaScript(baseManifest());
    expect(sh).toContain("daytona create --no-ide");
  });

  it("starts tutti-ai serve over SSH against the mounted score path", () => {
    const sh = buildDaytonaScript(baseManifest({ name: "marketing-agent" }));
    expect(sh).toContain('WORKSPACE_DIR="/workspaces/marketing-agent"');
    expect(sh).toContain(
      'daytona ssh -- tutti-ai serve --score "$WORKSPACE_DIR/tutti.score.ts"',
    );
  });

  it("uses bash strict mode like every other deploy.sh", () => {
    const sh = buildDaytonaScript(baseManifest());
    expect(sh.startsWith("#!/usr/bin/env bash")).toBe(true);
    expect(sh).toContain("set -euo pipefail");
  });
});

describe("generateDaytonaBundle", () => {
  afterAll(() => {
    for (const dir of created) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  it("writes .devcontainer/devcontainer.json, .daytona/snapshots.yaml, .gitignore, daytona.sh", async () => {
    const dir = tempDir();
    await generateDaytonaBundle(baseManifest(), dir);

    expect(existsSync(resolve(dir, ".devcontainer", "devcontainer.json"))).toBe(true);
    expect(existsSync(resolve(dir, ".daytona", "snapshots.yaml"))).toBe(true);
    expect(existsSync(resolve(dir, ".gitignore"))).toBe(true);
    expect(existsSync(resolve(dir, "daytona.sh"))).toBe(true);
  });

  it("creates outDir when it does not yet exist", async () => {
    const parent = tempDir();
    const nested = resolve(parent, "nested", "build");
    expect(existsSync(nested)).toBe(false);

    await generateDaytonaBundle(baseManifest(), nested);

    expect(existsSync(resolve(nested, ".devcontainer", "devcontainer.json"))).toBe(
      true,
    );
  });

  it("writes daytona.sh with execute permission", async () => {
    const dir = tempDir();
    await generateDaytonaBundle(baseManifest(), dir);

    const stat = statSync(resolve(dir, "daytona.sh"));
    if (process.platform !== "win32") {
      expect(stat.mode & 0o100).toBe(0o100);
    }
  });

  it("matches the snapshot for a representative manifest", async () => {
    const dir = tempDir();
    await generateDaytonaBundle(
      baseManifest({
        name: "marketing-agent",
        env: { LOG_LEVEL: "info" },
      }),
      dir,
    );

    const devcontainer = readFileSync(
      resolve(dir, ".devcontainer", "devcontainer.json"),
      "utf-8",
    );
    const snapshots = readFileSync(
      resolve(dir, ".daytona", "snapshots.yaml"),
      "utf-8",
    );
    const gitignore = readFileSync(resolve(dir, ".gitignore"), "utf-8");
    const script = readFileSync(resolve(dir, "daytona.sh"), "utf-8");

    expect({ devcontainer, snapshots, gitignore, script }).toMatchSnapshot();
  });
});
