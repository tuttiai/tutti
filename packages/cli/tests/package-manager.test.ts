import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({ spawnSync: vi.fn() }));
vi.mock("node:child_process", () => ({ spawnSync: mocks.spawnSync }));

import { runPackageManager } from "../src/package-manager.js";

const realPlatform = Object.getOwnPropertyDescriptor(process, "platform");

function setPlatform(value: string): void {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

function enoent(): Error {
  return Object.assign(new Error("spawnSync npm ENOENT"), { code: "ENOENT" });
}

describe("runPackageManager", () => {
  beforeEach(() => {
    mocks.spawnSync.mockReset();
    setPlatform("linux");
  });

  afterEach(() => {
    if (realPlatform) Object.defineProperty(process, "platform", realPlatform);
  });

  it("runs npm with an argument array and no shell", () => {
    mocks.spawnSync.mockReturnValue({ status: 0, stdout: null, error: undefined });
    const result = runPackageManager("npm", ["install", "@tuttiai/slack"], { cwd: "/proj" });

    expect(result).toEqual({ ok: true, stdout: "" });
    expect(mocks.spawnSync).toHaveBeenCalledTimes(1);
    const [cmd, args, options] = mocks.spawnSync.mock.calls[0] ?? [];
    expect(cmd).toBe("npm");
    expect(args).toEqual(["install", "@tuttiai/slack"]);
    expect(options).toMatchObject({ cwd: "/proj", shell: false, stdio: "inherit" });
  });

  it("captures stdout when asked", () => {
    mocks.spawnSync.mockReturnValue({ status: 0, stdout: "1.4.0\n" });
    const result = runPackageManager("npm", ["view", "@tuttiai/core", "version"], { capture: true });

    expect(result).toEqual({ ok: true, stdout: "1.4.0\n" });
    expect(mocks.spawnSync.mock.calls[0]?.[2]).toMatchObject({ stdio: "pipe", shell: false });
  });

  it("reports a non-zero exit with the command and its code", () => {
    mocks.spawnSync.mockReturnValue({ status: 1, stdout: null });
    expect(runPackageManager("npm", ["install", "@tuttiai/slack"])).toEqual({
      ok: false,
      status: 1,
      error: "npm install @tuttiai/slack failed (exit code 1).",
    });
  });

  it("reports a command killed by a signal", () => {
    mocks.spawnSync.mockReturnValue({ status: null, signal: "SIGTERM", stdout: null });
    const result = runPackageManager("pnpm", ["add", "@tuttiai/core@latest"]);
    expect(result).toEqual({
      ok: false,
      status: null,
      error: "pnpm add @tuttiai/core@latest failed (signal SIGTERM).",
    });
  });

  it("explains a missing npm (ENOENT)", () => {
    mocks.spawnSync.mockReturnValue({ status: null, stdout: null, error: enoent() });
    expect(runPackageManager("npm", ["install", "x"])).toEqual({
      ok: false,
      status: null,
      error: "Could not run npm. Is Node.js/npm installed and on your PATH?",
    });
  });

  it("reports any other spawn error by its message", () => {
    mocks.spawnSync.mockReturnValue({ status: null, stdout: null, error: new Error("EACCES") });
    const result = runPackageManager("yarn", ["add", "x"]);
    expect(result).toEqual({ ok: false, status: null, error: "Could not run yarn: EACCES" });
  });

  it("never throws, even when spawnSync does", () => {
    mocks.spawnSync.mockImplementation(() => {
      throw new TypeError("bad argument");
    });
    const result = runPackageManager("npm", ["install", "x"]);
    expect(result).toEqual({ ok: false, status: null, error: "Could not run npm: bad argument" });
  });

  it("on Windows runs the .cmd shim with each argument quoted", () => {
    setPlatform("win32");
    mocks.spawnSync.mockReturnValue({ status: 0, stdout: null });
    runPackageManager("npm", ["install", "@acme/voice@^1.2.0"]);

    const [line, options] = mocks.spawnSync.mock.calls[0] ?? [];
    expect(line).toBe('npm.cmd "install" "@acme/voice@^1.2.0"');
    expect(options).toMatchObject({ shell: true, windowsHide: true });
  });
});
