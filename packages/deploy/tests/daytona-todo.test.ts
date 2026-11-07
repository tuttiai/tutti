import { describe, it, expect, afterAll } from "vitest";
import { resolve } from "node:path";
import { readFileSync, readdirSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

import {
  buildDaytonaScript,
  buildSnapshotsYaml,
  generateDaytonaBundle,
} from "../src/targets/daytona.js";
import type { DeployManifest } from "../src/types.js";

const ISSUE_URL = "https://github.com/tuttiai/tutti/issues/67";
const created: string[] = [];

function manifest(name = "my-agent"): DeployManifest {
  return {
    agent_name: "api",
    target: "daytona",
    name,
    region: "auto",
    env: {},
    secrets: [],
    scale: { minInstances: 0, maxInstances: 3 },
    healthCheck: { path: "/health", intervalSeconds: 30 },
    services: { postgres: false, redis: false },
  };
}

/** Every file under `dir`, as paths relative to it. */
function listFiles(dir: string, prefix = ""): string[] {
  return readdirSync(resolve(dir, prefix), { withFileTypes: true }).flatMap(
    (entry) => {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      return entry.isDirectory() ? listFiles(dir, rel) : [rel];
    },
  );
}

afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

describe("Daytona generated text carries no TODO (#67)", () => {
  it("snapshots.yaml has no TODO and links the tracked issue in full", () => {
    const yaml = buildSnapshotsYaml();
    expect(yaml).not.toMatch(/todo/i);
    expect(yaml).toContain(ISSUE_URL);
    expect(yaml).toContain("idle_minutes_until_hibernate and auto_resume");
    expect(yaml).toContain("hibernation in your Daytona sandbox settings");
  });

  it("snapshots.yaml keeps the same keys and values; only comments changed", () => {
    const data = buildSnapshotsYaml()
      .split("\n")
      .filter((line) => line !== "" && !line.startsWith("#"));
    expect(data).toEqual(["idle_minutes_until_hibernate: 5", "auto_resume: true"]);
  });

  it("does not write the bare #67, which would point at the buyer's own issue", () => {
    const withoutUrl = buildSnapshotsYaml().split(ISSUE_URL).join("");
    expect(withoutUrl).not.toContain("#67");
  });

  it("daytona.sh has no TODO for any deployment name", () => {
    expect(buildDaytonaScript(manifest())).not.toMatch(/todo/i);
    expect(buildDaytonaScript(manifest("x"))).not.toMatch(/todo/i);
  });

  it("emits no TODO in any generated file", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "tutti-deploy-daytona-todo-"));
    created.push(dir);
    await generateDaytonaBundle(manifest(), dir);

    const files = listFiles(dir);
    expect(files.sort()).toEqual([
      ".daytona/snapshots.yaml",
      ".devcontainer/devcontainer.json",
      ".gitignore",
      "daytona.sh",
    ]);
    for (const file of files) {
      expect(readFileSync(resolve(dir, file), "utf-8"), file).not.toMatch(/todo/i);
    }
  });

  it("every TODO in the daytona.ts source is tracked as TODO(#67)", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "../src/targets/daytona.ts"),
      "utf-8",
    );
    const all = source.match(/\bTODO\b/gi) ?? [];
    const tracked = source.match(/\bTODO\(#67\)/g) ?? [];
    expect(all.length).toBeGreaterThan(0);
    expect(tracked.length).toBe(all.length);
    expect(source).not.toContain("TODO(deploy/daytona)");
  });
});
