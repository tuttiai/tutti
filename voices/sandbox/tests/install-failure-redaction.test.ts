import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ToolContext, ToolResult } from "@tuttiai/types";
import { SessionSandbox } from "../src/sandbox.js";
import { execute } from "../src/executor.js";
import type { ExecResult } from "../src/executor.js";
import { createInstallPackageTool } from "../src/tools/install-package.js";

// Mocked so npm and pip failures are simulated without a registry or a child
// process. Kept in this file only: vi.mock applies to the whole file and would
// replace the real executor elsewhere.
vi.mock("../src/executor.js", () => ({ execute: vi.fn() }));

const ctx: ToolContext = {
  session_id: "test-session",
  agent_name: "test-agent",
};

const INSTALL_HINT =
  "Check the package name is spelt correctly and is allowed in this sandbox.";

let sandbox: SessionSandbox;

beforeEach(async () => {
  sandbox = new SessionSandbox("install-fail-" + Date.now());
  await sandbox.init();
  vi.mocked(execute).mockReset();
});

afterEach(async () => {
  await sandbox.destroy();
});

/** A finished install with the given exit code and stderr. */
function failed(exitCode: number, stderr: string): ExecResult {
  return { stdout: "", stderr, exit_code: exitCode, duration_ms: 1, truncated: false };
}

async function install(name: string, manager: "npm" | "pip"): Promise<ToolResult> {
  const tool = createInstallPackageTool(sandbox);
  return tool.execute(tool.parameters.parse({ name, manager }), ctx);
}

/** Assert an error result hides the root, shows `<workdir>` and ends with the hint. */
function expectRedacted(result: ToolResult): void {
  expect(result.is_error).toBe(true);
  expect(result.content).not.toContain(sandbox.root);
  expect(result.content).toContain("<workdir>");
  expect(result.content.endsWith("\n" + INSTALL_HINT)).toBe(true);
}

describe("install_package failed install redaction", () => {
  it("hides every occurrence of the root in npm stderr", async () => {
    const root = sandbox.root;
    vi.mocked(execute).mockResolvedValueOnce(
      failed(1, `npm ERR! enoent ${root}/package.json\nnpm ERR! log ${root}/npm.log`),
    );
    const result = await install("is-odd", "npm");
    expectRedacted(result);
    expect(result.content).toBe(
      "Failed to install is-odd via npm:\n" +
        "npm ERR! enoent <workdir>/package.json\nnpm ERR! log <workdir>/npm.log\n" +
        INSTALL_HINT,
    );
  });

  it("hides the root in pip stderr", async () => {
    vi.mocked(execute).mockResolvedValueOnce(
      failed(1, `ERROR: Could not install packages into ${sandbox.root}/lib`),
    );
    const result = await install("numpy", "pip");
    expectRedacted(result);
    expect(result.content.startsWith("Failed to install numpy via pip:\n")).toBe(true);
    expect(result.content).toContain("into <workdir>/lib");
  });

  it("hides the root in a spawn error (exit 127)", async () => {
    vi.mocked(execute).mockResolvedValueOnce(
      failed(127, `spawn /bin/bash ENOENT, cwd '${sandbox.root}'`),
    );
    const result = await install("is-odd", "npm");
    expectRedacted(result);
    expect(result.content).toContain("cwd '<workdir>'");
  });

  it("still ends with the hint when stderr is empty", async () => {
    vi.mocked(execute).mockResolvedValueOnce(failed(1, ""));
    const result = await install("is-odd", "npm");
    expect(result.is_error).toBe(true);
    expect(result.content).toBe("Failed to install is-odd via npm:\n\n" + INSTALL_HINT);
  });
});
