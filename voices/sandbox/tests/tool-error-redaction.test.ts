import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ToolContext, ToolResult } from "@tuttiai/types";
import { SessionSandbox } from "../src/sandbox.js";
import { execute } from "../src/executor.js";
import { createReadFileTool } from "../src/tools/read-file.js";
import { createWriteFileTool } from "../src/tools/write-file.js";
import { createInstallPackageTool } from "../src/tools/install-package.js";
import { createExecuteCodeTool } from "../src/tools/run-code.js";

// Mocked so the install and run catch blocks are reached without a real
// npm registry or child process. Kept in this file only: vi.mock applies
// to the whole file and would replace the real executor elsewhere.
vi.mock("../src/executor.js", () => ({ execute: vi.fn() }));

const ctx: ToolContext = {
  session_id: "test-session",
  agent_name: "test-agent",
};

const READ_HINT = "Check the path is inside the sandbox and the file exists.";
const WRITE_HINT =
  "Check the path is inside the sandbox and its parent folder exists and can be written to.";
const INSTALL_HINT =
  "Check the package name is spelt correctly and is allowed in this sandbox.";
const RUN_HINT =
  "Check the code is valid for the chosen language and finishes within the time limit.";

let sandbox: SessionSandbox;

beforeEach(async () => {
  sandbox = new SessionSandbox("redact-" + Date.now());
  await sandbox.init();
  vi.mocked(execute).mockReset();
});

afterEach(async () => {
  await sandbox.destroy();
});

/** Assert an error result hides `root`, shows `<workdir>` and ends with `hint`. */
function expectRedacted(result: ToolResult, root: string, hint: string): void {
  expect(result.is_error).toBe(true);
  expect(result.content).not.toContain(root);
  expect(result.content).toContain("<workdir>");
  expect(result.content.endsWith("\n" + hint)).toBe(true);
}

describe("read_file error redaction", () => {
  it("hides the host path when the file is missing", async () => {
    const tool = createReadFileTool(sandbox);
    const result = await tool.execute(
      tool.parameters.parse({ path: "nope.txt" }),
      ctx,
    );
    expectRedacted(result, sandbox.root, READ_HINT);
    expect(result.content).toContain("ENOENT");
    expect(result.content).toContain("<workdir>/nope.txt");
  });

  it("keeps the escape message and adds the hint", async () => {
    const tool = createReadFileTool(sandbox);
    const result = await tool.execute(
      tool.parameters.parse({ path: "../../etc/passwd" }),
      ctx,
    );
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("escapes the sandbox");
    expect(result.content.endsWith("\n" + READ_HINT)).toBe(true);
  });
});

describe("write_file error redaction", () => {
  it("hides the host path when the target is a directory", async () => {
    const tool = createWriteFileTool(sandbox);
    const result = await tool.execute(
      tool.parameters.parse({ path: ".", content: "x" }),
      ctx,
    );
    expectRedacted(result, sandbox.root, WRITE_HINT);
    expect(result.content).toContain("EISDIR");
  });

  it("keeps the escape message and adds the hint", async () => {
    const tool = createWriteFileTool(sandbox);
    const result = await tool.execute(
      tool.parameters.parse({ path: "../outside.txt", content: "evil" }),
      ctx,
    );
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("escapes the sandbox");
    expect(result.content.endsWith("\n" + WRITE_HINT)).toBe(true);
  });
});

describe("install_package error redaction", () => {
  it("hides the host path when the install rejects", async () => {
    vi.mocked(execute).mockRejectedValueOnce(
      new Error(`EACCES: permission denied, mkdir '${sandbox.root}/node_modules'`),
    );
    const tool = createInstallPackageTool(sandbox);
    const result = await tool.execute(
      tool.parameters.parse({ name: "is-odd" }),
      ctx,
    );
    expectRedacted(result, sandbox.root, INSTALL_HINT);
    expect(result.content).toContain(
      "Install failed: EACCES: permission denied, mkdir '<workdir>/node_modules'",
    );
  });

  it("redacts every occurrence of the root", async () => {
    vi.mocked(execute).mockRejectedValueOnce(
      new Error(`cannot copy ${sandbox.root}/a to ${sandbox.root}/b`),
    );
    const tool = createInstallPackageTool(sandbox);
    const result = await tool.execute(
      tool.parameters.parse({ name: "is-odd" }),
      ctx,
    );
    expectRedacted(result, sandbox.root, INSTALL_HINT);
    expect(result.content).toContain("cannot copy <workdir>/a to <workdir>/b");
  });
});

describe("execute_code error redaction", () => {
  it("hides the sandbox root when execution rejects", async () => {
    vi.mocked(execute).mockRejectedValueOnce(
      new Error(`ENOENT: no such file or directory, chdir '${sandbox.root}'`),
    );
    const tool = createExecuteCodeTool({ sandbox });
    const result = await tool.execute(
      tool.parameters.parse({ code: "x", language: "bash" }),
      ctx,
    );
    expectRedacted(result, sandbox.root, RUN_HINT);
    expect(result.content).toContain("Execution failed: ENOENT");
  });

  it("falls back to defaults.working_dir when there is no sandbox", async () => {
    const dir = sandbox.root;
    vi.mocked(execute).mockRejectedValueOnce(new Error(`spawn failed in ${dir}`));
    const tool = createExecuteCodeTool({ defaults: { working_dir: dir } });
    const result = await tool.execute(
      tool.parameters.parse({ code: "x", language: "bash" }),
      ctx,
    );
    expectRedacted(result, dir, RUN_HINT);
  });

  it("redacts and adds the hint when a non-Error value is thrown", async () => {
    vi.mocked(execute).mockRejectedValueOnce(`killed while in ${sandbox.root}`);
    const tool = createExecuteCodeTool({ sandbox });
    const result = await tool.execute(
      tool.parameters.parse({ code: "x", language: "bash" }),
      ctx,
    );
    expectRedacted(result, sandbox.root, RUN_HINT);
    expect(result.content).toContain("killed while in <workdir>");
  });

  it("leaves the message as it is when there is no directory to redact", async () => {
    vi.mocked(execute).mockRejectedValueOnce(new Error("spawn bash ENOENT"));
    const tool = createExecuteCodeTool();
    const result = await tool.execute(
      tool.parameters.parse({ code: "x", language: "bash" }),
      ctx,
    );
    expect(result.is_error).toBe(true);
    expect(result.content).toBe("Execution failed: spawn bash ENOENT\n" + RUN_HINT);
  });
});
