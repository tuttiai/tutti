import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

const originalCwd = process.cwd;
const originalExit = process.exit;

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `tutti-cli-test-${randomUUID()}`);
  mkdirSync(testDir, { recursive: true });
  process.cwd = () => testDir;
});

afterEach(() => {
  process.cwd = originalCwd;
  process.exit = originalExit;
  rmSync(testDir, { recursive: true, force: true });
});

describe("initCommand", () => {
  it("creates all expected files in the project directory", async () => {
    const { initCommand } = await import("../../src/commands/init.js");

    await initCommand("my-project", "minimal");

    const projectDir = join(testDir, "my-project");
    expect(existsSync(projectDir)).toBe(true);

    const expectedFiles = [
      "package.json",
      "tsconfig.json",
      "tutti.score.ts",
      ".env.example",
      ".gitignore",
      "README.md",
    ];

    for (const file of expectedFiles) {
      expect(existsSync(join(projectDir, file))).toBe(true);
    }
  });

  it("writes valid JSON in package.json", async () => {
    const { initCommand } = await import("../../src/commands/init.js");

    await initCommand("json-test", "minimal");

    const pkgPath = join(testDir, "json-test", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));

    expect(pkg.name).toBe("json-test");
    expect(pkg.version).toBe("0.0.1");
    expect(pkg.type).toBe("module");
    expect(pkg.dependencies["@tuttiai/core"]).toBeDefined();
    expect(pkg.dependencies["@tuttiai/types"]).toBeDefined();
    expect(pkg.devDependencies.tsx).toBeDefined();
    expect(pkg.devDependencies.typescript).toBeDefined();
  });

  it("writes valid JSON in tsconfig.json", async () => {
    const { initCommand } = await import("../../src/commands/init.js");

    await initCommand("tsconfig-test", "minimal");

    const tscPath = join(testDir, "tsconfig-test", "tsconfig.json");
    const tsconfig = JSON.parse(readFileSync(tscPath, "utf-8"));

    expect(tsconfig.compilerOptions.strict).toBe(true);
    expect(tsconfig.compilerOptions.target).toBe("ES2022");
  });

  it("writes a valid tutti.score.ts with defineScore import", async () => {
    const { initCommand } = await import("../../src/commands/init.js");

    await initCommand("score-test", "minimal");

    const scorePath = join(testDir, "score-test", "tutti.score.ts");
    const content = readFileSync(scorePath, "utf-8");

    expect(content).toContain('import { defineScore, AnthropicProvider }');
    expect(content).toContain("export default defineScore(");
    expect(content).toContain("AnthropicProvider()");
  });

  it("writes .env.example with ANTHROPIC_API_KEY placeholder", async () => {
    const { initCommand } = await import("../../src/commands/init.js");

    await initCommand("env-test", "minimal");

    const envPath = join(testDir, "env-test", ".env.example");
    const content = readFileSync(envPath, "utf-8");

    expect(content).toContain("ANTHROPIC_API_KEY=your_key_here");
  });

  it("writes .gitignore that excludes .env", async () => {
    const { initCommand } = await import("../../src/commands/init.js");

    await initCommand("git-test", "minimal");

    const gitignorePath = join(testDir, "git-test", ".gitignore");
    const content = readFileSync(gitignorePath, "utf-8");

    expect(content).toContain("node_modules");
    expect(content).toContain(".env");
  });

  it("writes README with the project name", async () => {
    const { initCommand } = await import("../../src/commands/init.js");

    await initCommand("readme-test", "minimal");

    const readmePath = join(testDir, "readme-test", "README.md");
    const content = readFileSync(readmePath, "utf-8");

    expect(content).toContain("# readme-test");
    expect(content).toContain("Tutti");
  });

  it("exits with code 1 if directory already exists", async () => {
    const { initCommand } = await import("../../src/commands/init.js");

    mkdirSync(join(testDir, "existing-dir"));

    let exitCode: number | undefined;
    process.exit = ((code?: number) => {
      exitCode = code;
      throw new Error("process.exit called");
    }) as never;

    await expect(initCommand("existing-dir", "minimal")).rejects.toThrow(
      "process.exit called",
    );
    expect(exitCode).toBe(1);
  });

  it("does not create files outside the project directory", async () => {
    const { initCommand } = await import("../../src/commands/init.js");

    await initCommand("sandboxed", "minimal");

    expect(existsSync(join(testDir, "sandboxed"))).toBe(true);
    expect(existsSync(join(testDir, "package.json"))).toBe(false);
    expect(existsSync(join(testDir, "tutti.score.ts"))).toBe(false);
  });
});
