import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveInstalledVersion } from "../../src/commands/info.js";

describe("resolveInstalledVersion", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tutti-info-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns the installed package's version when node_modules has it", () => {
    const pkgDir = join(dir, "node_modules", "@tuttiai", "core");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ version: "0.18.3" }));

    expect(resolveInstalledVersion("@tuttiai/core", "*", dir)).toBe("0.18.3");
  });

  it("falls back to the spec when the package is not installed", () => {
    expect(resolveInstalledVersion("@tuttiai/missing", "^1.2.3", dir)).toBe("^1.2.3");
  });

  it("falls back to the spec when package.json is malformed", () => {
    const pkgDir = join(dir, "node_modules", "@tuttiai", "broken");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), "not json");

    expect(resolveInstalledVersion("@tuttiai/broken", "*", dir)).toBe("*");
  });

  it("falls back to the spec when package.json has no version", () => {
    const pkgDir = join(dir, "node_modules", "@tuttiai", "noversion");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "x" }));

    expect(resolveInstalledVersion("@tuttiai/noversion", "workspace:*", dir)).toBe("workspace:*");
  });
});
