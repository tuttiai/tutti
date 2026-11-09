import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { ToolContext, ToolResult } from "@tuttiai/types";
import { SessionSandbox } from "../src/sandbox.js";
import { createReadFileTool } from "../src/tools/read-file.js";
import { createWriteFileTool } from "../src/tools/write-file.js";

const ctx: ToolContext = {
  session_id: "test-session",
  agent_name: "test-agent",
};

const READ_HINT = "Check the path is inside the sandbox and the file exists.";
const WRITE_HINT =
  "Check the path is inside the sandbox and its parent folder exists and can be written to.";

let sandbox: SessionSandbox;

beforeEach(async () => {
  sandbox = new SessionSandbox("redact-" + Date.now());
  await sandbox.init();
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
