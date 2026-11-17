import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ToolContext, ToolResult } from "@tuttiai/types";
import { SessionSandbox } from "../src/sandbox.js";
import { execute } from "../src/executor.js";
import { createInstallPackageTool } from "../src/tools/install-package.js";
import type { InstallPackageOptions } from "../src/tools/install-package.js";

// Mocked so accepted names reach a fake executor instead of a registry, and so
// a rejected name can be shown never to spawn. Kept in this file only: vi.mock
// applies to the whole file and would replace the real executor elsewhere.
vi.mock("../src/executor.js", () => ({ execute: vi.fn() }));

const ctx: ToolContext = {
  session_id: "test-session",
  agent_name: "test-agent",
};

const INSTALL_HINT =
  "Check the package name is spelt correctly and is allowed in this sandbox.";
const OPTION_OR_PATH = 'must not start with "-", be an absolute path or contain "..".';

const MANAGERS = ["npm", "pip"] as const;

/** Read as an npm or pip option, or as a local path outside the sandbox. */
const OPTION_AND_PATH_NAMES = [
  "-g", "-r", "-", "/etc/x", "/", "../../pkg", "a/../b", "..", "pkg/..",
];

/** Already refused by the character check; kept so a wider regex stays safe. */
const META_NAMES = ["--prefix=/x", "C:\\x", "\\\\server\\x", "evil; rm -rf /"];

let sandbox: SessionSandbox;

beforeEach(async () => {
  sandbox = new SessionSandbox("install-names-" + Date.now());
  await sandbox.init();
  vi.mocked(execute).mockReset();
  vi.mocked(execute).mockResolvedValue({
    stdout: "", stderr: "", exit_code: 0, duration_ms: 1, truncated: false,
  });
});

afterEach(async () => {
  await sandbox.destroy();
});

async function install(
  name: string,
  manager: "npm" | "pip",
  opts?: InstallPackageOptions,
): Promise<ToolResult> {
  const tool = createInstallPackageTool(sandbox, opts);
  return tool.execute(tool.parameters.parse({ name, manager }), ctx);
}

/** Assert the call was refused with the hint and nothing was spawned. */
function expectRefused(result: ToolResult, name: string): void {
  expect(result.is_error).toBe(true);
  expect(result.content.startsWith(`Invalid package name "${name}": `)).toBe(true);
  expect(result.content.endsWith("\n" + INSTALL_HINT)).toBe(true);
  expect(execute).not.toHaveBeenCalled();
}

describe.each(MANAGERS)("install_package name validation (%s)", (manager) => {
  it.each(OPTION_AND_PATH_NAMES)("rejects %s as an option or path", async (name) => {
    const result = await install(name, manager);
    expectRefused(result, name);
    expect(result.content).toContain(OPTION_OR_PATH);
  });

  it.each(META_NAMES)("rejects %s by its characters", async (name) => {
    const result = await install(name, manager);
    expectRefused(result, name);
    expect(result.content).toContain("must contain only alphanumeric characters");
  });

  it("rejects an option even when it is on the allowlist", async () => {
    const result = await install("-g", manager, { allowedPackages: ["-g", "lodash"] });
    expectRefused(result, "-g");
    expect(result.content).not.toContain("allowed list");
  });
});

describe("install_package accepted names", () => {
  const accepted: Array<[string, "npm" | "pip"]> = [
    ["lodash", "npm"],
    ["@scope/pkg", "npm"],
    ["pkg@1.2.3", "npm"],
    ["@scope/pkg@1.2.3", "npm"],
    ["my_pkg.js", "npm"],
    ["my-pkg", "npm"],
    ["numpy", "pip"],
  ];

  it.each(accepted)("passes %s to %s unchanged", async (name, manager) => {
    const result = await install(name, manager);
    expect(result.is_error).toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(1);
    const cmd = vi.mocked(execute).mock.calls[0]?.[0] ?? "";
    expect(cmd.endsWith(`" ${name}`)).toBe(true);
  });
});
